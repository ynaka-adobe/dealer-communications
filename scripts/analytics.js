/**
 * analytics.js — block-aware auto-instrumentation for AEM Edge Delivery.
 *
 * The idea: in EDS, every component is a `div` whose class name *is* the block
 * name (`<div class="cards products block" data-block-name="cards">`). That
 * gives us a reliable, universal component boundary — so we can instrument the
 * entire site generically, with zero per-block tagging code. Add a brand-new
 * block tomorrow and it is measured the moment it renders, with no analytics
 * work at all.
 *
 * Everything below runs in the DELAYED phase (see scripts/delayed.js) so it
 * cannot affect LCP / CWV.
 *
 * Data flows: DOM ─▶ this module ─▶ window.adobeDataLayer ─▶ transport adapter.
 * `window.adobeDataLayer` follows the Adobe Client Data Layer convention, so a
 * Tags (Launch) property could consume the exact same events instead.
 *
 * The transport is deliberately swappable (scripts/analytics-transport/): Web
 * SDK, classic AppMeasurement, or a credential-free debug console. This module
 * knows nothing about any of them — which is what makes the instrumentation
 * reusable regardless of how the customer's Adobe stack is configured.
 *
 * Nothing is collected until consent is granted — events are held in an
 * in-memory queue and flushed on grant. See scripts/consent.js.
 */
import { getMetadata } from './aem.js';
import { getAnalyticsConfig } from './analytics-config.js';
import createTransport from './analytics-transport/index.js';
import { onConsentChange } from './consent.js';

const CONSENT_CATEGORY = 'analytics';
const SCROLL_MILESTONES = [25, 50, 75, 100];
const DOWNLOAD_EXTENSIONS = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|csv|txt|rtf|dwg|dxf|eps|ai|psd|mp4|mov|avi|mp3|wav)(?:$|\?|#)/i;

/** Events observed before consent. Flushed on grant, dropped on refusal. */
let queue = [];
let granted = false;
let debug = false;
let started = false;
let pageContext = null;
let blockSequence = 0;
let transport = null;
let layerWrapped = false;
const subscribers = new Set();

/* ─────────────────────────────── helpers ───────────────────────────────── */

function isDebug() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has('analytics-debug')) {
      const on = params.get('analytics-debug') !== '0';
      window.localStorage.setItem('analytics-debug', on ? '1' : '0');
      return on;
    }
    return window.localStorage.getItem('analytics-debug') === '1';
  } catch (e) {
    return false;
  }
}

function log(note, entry) {
  if (!debug) return;
  // eslint-disable-next-line no-console
  console.debug(`%c[analytics] ${note}`, 'color:#888', entry?.event || '');
}

function getLocale() {
  const seg = window.location.pathname.split('/')[1];
  return /^[a-z]{2}(-[a-z]{2})?$/i.test(seg) ? seg.toLowerCase() : 'en';
}

/** The page template this site reports: its handful of pages, unless one is authored in metadata. */
const TEMPLATES = {
  '': 'home', archive: 'archive', preview: 'preview', 'create-draft': 'create-draft', access: 'access',
};

function getPageContext() {
  if (pageContext) return pageContext;
  const path = window.location.pathname;
  const sections = document.querySelectorAll('main > .section').length;
  const first = path.split('/').filter(Boolean)[0] || '';
  pageContext = {
    name: (getMetadata('og:title') || document.title || path).trim(),
    path,
    url: window.location.href,
    locale: getLocale(),
    template: getMetadata('template')?.trim() || TEMPLATES[first] || 'default',
    siteSection: first || 'home',
    sectionCount: sections,
  };
  return pageContext;
}

/**
 * Derives the analytics identity of a block from its markup alone.
 * `<div class="cards products block" data-block-name="cards">` becomes
 * `{ name: 'cards', variants: ['products'], ... }`.
 * @param {Element} block
 */
export function describeBlock(block) {
  if (!block) return null;
  // `at-element-marker` is stamped on by at.js when Target applies an offer, and
  // `appear` by scripts.js section reveal — neither is an authored variant, so
  // they must not pollute the component identity reported to Analytics.
  const noise = new Set(['block', 'at-element-marker', 'appear']);
  const name = block.dataset.blockName
    || [...block.classList].find((c) => !noise.has(c))
    || 'unknown';
  const variants = [...block.classList].filter((c) => !noise.has(c) && c !== name);
  const section = block.closest('.section');
  const sections = section ? [...section.parentElement.children] : [];

  if (!block.dataset.analyticsPosition) {
    blockSequence += 1;
    block.dataset.analyticsPosition = String(blockSequence);
  }

  // Declarative, OPTIONAL enrichment: any `data-analytics-foo="bar"` authored
  // on the block (or injected by block JS) rides along as `attributes.foo`.
  const attributes = {};
  Object.entries(block.dataset).forEach(([key, value]) => {
    const internal = ['analyticsPosition', 'analyticsName', 'analyticsObserved'];
    if (key.startsWith('analytics') && !internal.includes(key)) {
      const short = key.slice('analytics'.length);
      attributes[short.charAt(0).toLowerCase() + short.slice(1)] = value;
    }
  });

  return {
    name: block.dataset.analyticsName || name,
    variants,
    id: variants.length ? `${name}|${variants.join('|')}` : name,
    sectionIndex: section ? sections.indexOf(section) + 1 : 0,
    position: Number(block.dataset.analyticsPosition),
    ...(Object.keys(attributes).length ? { attributes } : {}),
  };
}

/* ──────────────────────────── the data layer ───────────────────────────── */

/**
 * Pushes an event onto `window.adobeDataLayer`, or queues it until consent.
 * @param {string} event event name, e.g. `block-view`
 * @param {object} [payload] event-specific detail
 */
export function track(event, payload = {}) {
  const entry = {
    event,
    eventInfo: {
      timestamp: new Date().toISOString(),
      path: window.location.pathname,
    },
    page: getPageContext(),
    ...payload,
  };

  if (!granted) {
    queue.push(entry);
    log('queued — awaiting consent', entry);
    return;
  }
  window.adobeDataLayer.push(entry);
}

/**
 * Reports an event that belongs to a block, with that block's identity attached. For the parts of
 * the site that are not plain links and <form>s (the Create Draft journey), so they land in the
 * same data layer, and the same report suite variables, as everything else.
 * @param {string} event e.g. `form-start`, `form-submit`
 * @param {Element} block the block the event belongs to
 * @param {object} [payload] event detail, e.g. `{ form: { name } }`
 */
export function trackBlockEvent(event, block, payload = {}) {
  track(event, { component: describeBlock(block), ...payload });
}

function flush() {
  const pending = queue;
  queue = [];
  if (debug && pending.length) {
    // eslint-disable-next-line no-console
    console.info(`%c[analytics] consent granted — flushing ${pending.length} queued event(s)`, 'color:#d10411;font-weight:700');
  }
  pending.forEach((entry) => {
    window.adobeDataLayer.push(entry);
    log('flushed', entry);
  });
}

/* ─────────────────────────── auto-instrumentation ──────────────────────── */

/** Component impressions — fires once per block, when it scrolls into view. */
function observeBlocks() {
  const seen = new WeakSet();
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting || seen.has(entry.target)) return;
      seen.add(entry.target);
      observer.unobserve(entry.target);
      const component = describeBlock(entry.target);
      track('block-view', { component });
      if (entry.target.querySelector('form, .marketo')) {
        track('form-view', { component, form: { name: component.name } });
      }
    });
  }, { threshold: 0.4, rootMargin: '0px 0px -10% 0px' });

  const register = (root) => {
    const blocks = root.matches?.('[data-block-name], .block')
      ? [root]
      : [...root.querySelectorAll?.('[data-block-name], .block') || []];
    blocks.forEach((block) => {
      if (block.dataset.analyticsObserved) return;
      block.dataset.analyticsObserved = '1';
      observer.observe(block);
    });
  };

  register(document.body);

  // THE DEMO BEAT: blocks rendered later — lazily loaded sections, fragments,
  // Target-injected offers, or a brand-new block authored next week — are
  // picked up automatically here. No per-block analytics code, ever.
  const mutation = new MutationObserver((records) => {
    records.forEach((record) => {
      if (record.type === 'attributes') {
        // Markup is often injected raw and only decorated a tick later (Target
        // offers, fragments, lazily loaded sections). At childList time there is
        // no [data-block-name] yet, so watch for decorateBlock() stamping it on.
        register(record.target);
        return;
      }
      record.addedNodes.forEach((node) => {
        if (node.nodeType === 1) register(node);
      });
    });
  });
  mutation.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-block-name'],
  });
}

/**
 * Readable label for a link. EDS cards often wrap a whole card in one anchor, so
 * a raw textContent would be a paragraph — prefer an explicit label, then a
 * heading inside the link, before falling back to collapsed text.
 * @param {Element} el
 */
function linkText(el) {
  const clean = (v) => (v || '').replace(/\s+/g, ' ').trim();
  // an explicit label wins, so a control that names a record (its aria-label) is reported generically
  const explicit = clean(el.getAttribute('data-analytics-label'));
  if (explicit) return explicit.slice(0, 100);
  const label = clean(el.getAttribute('aria-label'));
  if (label) return label.slice(0, 100);
  // note: scripts.js decorateButtons() copies full text into `title`, so a
  // heading inside the link is a better label than the title attribute.
  const heading = el.querySelector('h1, h2, h3, h4, h5, h6, strong');
  if (heading) return clean(heading.textContent).slice(0, 100);
  const text = clean(el.textContent);
  if (text) return text.slice(0, 100);
  const img = el.querySelector('img[alt]');
  return img ? clean(img.alt).slice(0, 100) : '';
}

function classifyLink(el) {
  const href = el.getAttribute('href') || '';
  if (!href || href.startsWith('#')) return { type: 'anchor', href };
  if (el.hasAttribute('download')) return { type: 'download', href: href.startsWith('blob:') ? `download:${el.getAttribute('download')}` : href };
  if (/^(mailto|tel):/i.test(href)) return { type: href.split(':')[0].toLowerCase(), href };
  if (DOWNLOAD_EXTENSIONS.test(href)) return { type: 'download', href };
  try {
    const url = new URL(href, window.location.href);
    return {
      type: url.hostname === window.location.hostname ? 'internal' : 'external',
      href: url.href,
      domain: url.hostname,
    };
  } catch (e) {
    return { type: 'internal', href };
  }
}

/** One delegated listener covers every CTA, nav link and download, site-wide. */
function observeClicks() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('a[href], button');
    // Consent UI is privacy plumbing, not content — never track clicks on the
    // banner itself or on the footer control that reopens it.
    if (!el || el.closest('.consent') || el.closest('[data-consent-reopen]')) return;

    const link = classifyLink(el);
    let region = 'main';
    if (el.closest('header')) region = 'header';
    else if (el.closest('footer')) region = 'footer';
    const block = el.closest('[data-block-name], .block');
    const component = describeBlock(block);
    const text = linkText(el);

    const payload = {
      component,
      link: {
        text,
        ...link,
        region,
        elementType: el.tagName.toLowerCase(),
        isCta: el.classList.contains('button'),
      },
    };

    if (link.type === 'download') {
      const file = el.getAttribute('download') || link.href.split('/').pop().split(/[?#]/)[0];
      track('download-click', {
        ...payload,
        download: { fileName: file, fileType: (file.split('.').pop() || '').toLowerCase() },
      });
    } else if (region !== 'main') {
      track('navigation-click', payload);
    } else {
      track('cta-click', payload);
    }
  }, true);
}

/** Scroll depth — 25/50/75/100%, each fired at most once per page view. */
function observeScroll() {
  const pending = new Set(SCROLL_MILESTONES);
  let ticking = false;

  function onScroll() {
    if (ticking) return;
    ticking = true;
    // eslint-disable-next-line no-use-before-define
    window.requestAnimationFrame(measure);
  }

  const measure = () => {
    ticking = false;
    const { scrollHeight } = document.documentElement;
    const viewport = window.innerHeight;
    const scrollable = Math.max(scrollHeight - viewport, 1);
    const percent = Math.min(100, Math.round(((window.scrollY + viewport) / scrollHeight) * 100));
    const reached = Math.min(100, Math.round((window.scrollY / scrollable) * 100));
    const depth = Math.max(percent, reached);
    SCROLL_MILESTONES.forEach((milestone) => {
      if (depth >= milestone && pending.has(milestone)) {
        pending.delete(milestone);
        track('scroll-depth', { scroll: { depth: milestone, unit: 'percent' } });
      }
    });
    if (!pending.size) window.removeEventListener('scroll', onScroll);
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  measure();
}

/**
 * Form engagement. Generic for any `<form>` inside a block, plus a Marketo hook
 * so a lead-gen form reports a real submit rather than a page unload.
 */
function observeForms() {
  const startedForms = new WeakSet();

  document.addEventListener('focusin', (e) => {
    const field = e.target.closest('input, select, textarea');
    const form = field?.closest('form');
    if (!form || startedForms.has(form) || form.closest('.consent')) return;
    startedForms.add(form);
    const block = form.closest('[data-block-name], .block');
    track('form-start', {
      component: describeBlock(block),
      form: { name: describeBlock(block)?.name || form.id || 'form', id: form.id || '' },
    });
  }, true);

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || form.closest('.consent')) return;
    const block = form.closest('[data-block-name], .block');
    track('form-submit', {
      component: describeBlock(block),
      form: { name: describeBlock(block)?.name || form.id || 'form', id: form.id || '' },
    });
  }, true);

  // Marketo submits over XHR, so `submit` alone is unreliable — use its own API.
  const hookMarketo = () => {
    if (!window.MktoForms2?.whenReady) return false;
    window.MktoForms2.whenReady((form) => {
      const el = form.getFormElem?.()[0];
      const block = el?.closest('[data-block-name], .block');
      form.onSuccess(() => {
        track('form-submit', {
          component: describeBlock(block),
          form: { name: 'marketo', id: `mktoForm_${form.getId()}`, marketoFormId: form.getId() },
        });
        return true;
      });
    });
    return true;
  };
  if (!hookMarketo()) {
    let attempts = 0;
    const poll = window.setInterval(() => {
      attempts += 1;
      if (hookMarketo() || attempts > 40) window.clearInterval(poll);
    }, 500);
  }
}

/* ───────────────────────────── transport wiring ────────────────────────── */

/**
 * Boots the configured transport and pipes the data layer into it — everything
 * already buffered, plus everything pushed from now on. Wrapping `push` is what
 * the Adobe Client Data Layer library would do via `addEventListener`; doing it
 * by hand keeps us dependency-free.
 * @param {object} config
 */
/* ───────────────────────── data layer subscription ─────────────────────── */

/**
 * Single source of truth for consumers. `window.adobeDataLayer` stays a plain
 * array (Adobe Client Data Layer convention), so we wrap `push` exactly once
 * and fan out to every subscriber. The transport adapters and the insights
 * panel are both just subscribers — there is no second instrumentation path.
 * @param {(entry: object) => void} fn called for every event, past and future
 * @returns {() => void} unsubscribe
 */
export function subscribe(fn) {
  const layer = window.adobeDataLayer;
  if (!layerWrapped) {
    layerWrapped = true;
    const nativePush = layer.push.bind(layer);
    layer.push = (...entries) => {
      const result = nativePush(...entries);
      entries.forEach((entry) => {
        if (!entry?.event) return;
        subscribers.forEach((sub) => {
          try {
            sub(entry);
          } catch (e) {
            // a consumer must never be able to break the page
            // eslint-disable-next-line no-console
            console.error('[analytics] subscriber failed', e);
          }
        });
      });
      return result;
    };
  }

  subscribers.add(fn);
  // replay anything already collected, so a late subscriber is never behind
  layer.filter((entry) => entry?.event).forEach((entry) => fn(entry));
  return () => subscribers.delete(fn);
}

async function startTransport(config) {
  if (transport) return;
  transport = await createTransport(config);

  subscribe((entry) => {
    try {
      transport.send(entry);
    } catch (e) {
      // a transport must never be able to break the page
      // eslint-disable-next-line no-console
      console.error('[analytics] transport send failed', e);
    }
  });
}

/* ───────────────────────────────── boot ────────────────────────────────── */

/** Script errors that nothing caught, and promises that were rejected and never handled. */
function observeErrors() {
  let sent = 0;
  const report = (type, message, source, line) => {
    sent += 1;
    if (sent > 10) return; // one broken page must not flood the report
    track('js-error', {
      error: {
        type, message: String(message || '').slice(0, 120), source: String(source || '').split('/').pop().split('?')[0].slice(0, 60), line: Number(line) || 0,
      },
    });
  };
  window.addEventListener('error', (e) => {
    if (e.target && e.target !== window) return; // a missing image or script, not a script error
    report('script', e.message, e.filename, e.lineno);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    report('promise', r && r.message ? r.message : r, '', 0);
  });
}

function startCollection() {
  if (started) return;
  started = true;
  track('page-view');
  observeBlocks();
  observeClicks();
  observeScroll();
  observeForms();
  observeErrors();
}

/**
 * Initializes the data layer and the auto-instrumentation.
 * Called from scripts/delayed.js.
 */
export default async function initAnalytics() {
  const config = getAnalyticsConfig();
  if (!config.enabled) return;

  window.adobeDataLayer = window.adobeDataLayer || [];
  debug = isDebug();

  if (debug) {
    // eslint-disable-next-line no-console
    console.info(
      `%c[analytics] debug on%c — transport: ${config.mode} · data layer: window.adobeDataLayer`,
      'color:#d10411;font-weight:700',
      'color:inherit',
    );
  }

  // Consent is the on-switch. Collection starts immediately so that impressions
  // above the fold are not lost, but events stay in a private queue until the
  // visitor opts in — nothing reaches the data layer or the network before that.
  onConsentChange((categories) => {
    const nowGranted = categories?.[CONSENT_CATEGORY] === true;
    if (nowGranted && !granted) {
      granted = true;
      window.adobeDataLayer.push({
        event: 'consent-update',
        consent: { ...categories, status: 'granted' },
      });
      flush();
      startTransport(config);
    } else if (!nowGranted) {
      // refusal, or a later revocation: stop collecting and drop anything held
      granted = false;
      queue = [];
    }
  });

  startCollection();

  // Small surface for demos / debugging from the console.
  window.dealerAnalytics = {
    track,
    config,
    get transport() { return transport?.name || 'not started'; },
    /** Last Adobe Analytics collection URL — handy to show in a demo. */
    get lastHit() { return transport?.lastHit || null; },
    get events() { return window.adobeDataLayer.filter((e) => e.event); },
    dump() {
      // eslint-disable-next-line no-console
      console.table(window.adobeDataLayer
        .filter((e) => e.event)
        .map((e) => ({
          event: e.event,
          block: e.component?.name || '—',
          variants: e.component?.variants?.join(' ') || '—',
          section: e.component?.sectionIndex ?? '—',
          position: e.component?.position ?? '—',
          detail: e.link?.text || e.download?.fileName || e.form?.name
            || (e.scroll ? `${e.scroll.depth}%` : e.page?.path),
        })));
    },
  };
}
