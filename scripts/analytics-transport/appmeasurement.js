/**
 * analytics-transport/appmeasurement.js — classic Adobe Analytics transport.
 *
 * ★ This is the adapter that actually runs the demo. ★
 *
 * It sends the same data layer events into the customer's EXISTING Adobe
 * Analytics report suite, so they land in the Analysis Workspace they already
 * use — no Experience Platform datastream required.
 *
 * ── Two ways to send, same variable mapping ───────────────────────────────
 * AppMeasurement.js is not distributed on a public CDN (it is generated per
 * customer in Analytics ▸ Admin ▸ Code Manager), so this adapter works either
 * way and picks automatically at runtime:
 *
 *   1. LIBRARY mode — if a copy of AppMeasurement.js is reachable at
 *      `appMeasurementUrl`, we use the real thing: `s.t()` for page views and
 *      `s.tl()` for interactions, with `s.visitor` wired to the Experience
 *      Cloud ID service.
 *   2. BEACON mode (default today) — otherwise we construct the identical
 *      `/b/ss/{reportSuite}/1/...` image request ourselves. This is the
 *      documented Analytics data-collection URL, it needs no vendor file, and
 *      it keeps the project's "no new runtime dependencies" rule intact.
 *
 * Both modes produce hits to the same endpoint with the same variables, so the
 * Workspace report is identical. Dropping AppMeasurement.js into
 * `/deps/appmeasurement/` upgrades to library mode with no other change.
 *
 * ── Coexistence with at.js (important) ────────────────────────────────────
 * This site runs Adobe Target on at.js 2.11.x. If Analytics minted its own
 * identity while Target used another, the two solutions would count different
 * visitors for the same person and stitching (and A4T) would break.
 *
 * So we never load our own VisitorAPI.js. at.js 2.x does NOT bundle the
 * Experience Cloud ID service — verified in the browser, `window.Visitor` is
 * undefined after at.js initialises — so today there is no ECID on the site at
 * all and we send our own first-party visitor id as `vid`.
 *
 * The moment VisitorAPI.js is added (it is required anyway for A4T), we pick up
 * the instance it creates: `Visitor.getInstance(orgId)` is idempotent and
 * returns the existing singleton, and we send its ECID as `mid` instead. We
 * never send both, and we never construct a second Visitor instance.
 *
 * ── Variable mapping ──────────────────────────────────────────────────────
 * Documented in one place so an Analytics practitioner can create the matching
 * dimensions. See the PR description for the same table.
 *
 *   pageName  page title            events  event1 block impression
 *   channel   site section                  event2 CTA / navigation click
 *   eVar1/v1  page template                 event3 file download
 *   eVar2/v2  locale                        event4 form start
 *   eVar3/v3  component id (block|variant)  event5 form submit
 *   eVar4/v4  block name                    event6 scroll milestone
 *   eVar5/v5  block position on page
 *   eVar6/v6  section index         prop1/c1  page path
 *   eVar10/v10 link text            prop3/c3  component id
 *   eVar11/v11 link url             prop4/c4  block name
 *   eVar12/v12 download file name   prop10/c10 region:linkType
 *   eVar13/v13 scroll depth
 *   eVar14/v14 form name
 */

const JS_VERSION = 'JS-2.22.0';
const VISITOR_KEY = 'dealer-analytics-vid';

/** data layer event → Analytics success event + human-readable link name. */
const EVENT_MAP = {
  'block-view': { event: 'event1', label: 'Component Impression' },
  'cta-click': { event: 'event2', label: 'CTA Click' },
  'navigation-click': { event: 'event2', label: 'Navigation Click' },
  'download-click': { event: 'event3', label: 'File Download' },
  'form-start': { event: 'event4', label: 'Form Start' },
  'form-submit': { event: 'event5', label: 'Form Submit' },
  'scroll-depth': { event: 'event6', label: 'Scroll Depth' },
  'form-view': { event: '', label: 'Form View' },
  'form-error': { event: '', label: 'Form Error' },
  'api-error': { event: '', label: 'API Error' },
  'js-error': { event: '', label: 'Script Error' },
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.async = true;
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(script);
  });
}

/** Stable first-party visitor id, used only when no ECID is available. */
function getFallbackVisitorId() {
  try {
    let id = window.localStorage.getItem(VISITOR_KEY);
    if (!id) {
      id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      window.localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch (e) {
    return null;
  }
}

/** AppMeasurement's `t` parameter: `dd/mm/yyyy hh:mm:ss weekday tzoffset`. */
function timestampParam() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} `
    + `${d.getDay()} ${d.getTimezoneOffset()}`;
}

/**
 * Translates one data layer entry into Analytics variables.
 * Shared by both modes so the reporting is identical either way.
 * @param {object} entry
 */
export function toAnalyticsVars(entry) {
  const {
    event, page = {}, component, link, download, scroll, form, error,
  } = entry;
  const mapped = EVENT_MAP[event] || { event: '', label: event };

  const vars = {
    pageName: page.name,
    pageURL: page.url,
    channel: page.siteSection,
    events: mapped.event,
    eVar1: page.template,
    eVar2: page.locale,
    prop1: page.path,
  };

  if (component) {
    vars.eVar3 = component.id;
    vars.eVar4 = component.name;
    vars.eVar5 = String(component.position);
    vars.eVar6 = String(component.sectionIndex);
    vars.prop3 = component.id;
    vars.prop4 = component.name;
  }
  if (link) {
    vars.eVar10 = link.text;
    vars.eVar11 = link.href;
    vars.prop10 = `${link.region}:${link.type}`;
  }
  if (download) vars.eVar12 = download.fileName;
  if (scroll) vars.eVar13 = `${scroll.depth}%`;
  if (form) vars.eVar14 = form.name;

  // Link hits need a name and a type: 'd' download, 'e' exit, 'o' custom.
  let linkType = 'o';
  if (event === 'download-click') linkType = 'd';
  else if (link?.type === 'external') linkType = 'e';

  // an error names what failed, so the Custom Links report reads "API Error | POST review:approve 500"
  // (operations carry no ids and script messages are cut short, so this never holds personal data)
  const errorDetail = error
    ? [error.operation || error.message, error.status === undefined ? '' : error.status].filter((x) => x !== '').join(' ')
    : '';
  const detail = errorDetail || link?.text || download?.fileName || form?.name
    || (scroll ? `${scroll.depth}%` : component?.id);

  return {
    vars,
    isPageView: event === 'page-view',
    linkType,
    linkName: `${mapped.label}${detail ? ` | ${detail}` : ''}`.slice(0, 100),
    linkURL: link?.href || download?.fileName || page.url,
  };
}

/** Maps friendly variable names onto Analytics query parameters. */
function toQueryParams(vars) {
  const params = {};
  Object.entries(vars).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    const eVar = key.match(/^eVar(\d+)$/);
    const prop = key.match(/^prop(\d+)$/);
    if (eVar) params[`v${eVar[1]}`] = value;
    else if (prop) params[`c${prop[1]}`] = value;
    else if (key === 'pageURL') params.g = value;
    else if (key === 'channel') params.ch = value;
    else params[key] = value;
  });
  return params;
}

/**
 * @param {object} config
 * @returns {{name: string, init: () => Promise<boolean>, send: (e: object) => void}}
 */
export default function createAppMeasurementTransport(config) {
  const {
    reportSuiteId, trackingServer, appMeasurementUrl, orgId,
  } = config;
  let mode = 'beacon';
  let s = null;
  let visitor = null;
  /** Last hit URL, exposed for demos/QA (`dealerAnalytics.lastHit`). */
  let lastHit = null;

  /** Reuse at.js's ECID when Target is on the page; never create a second one. */
  function attachVisitor() {
    if (!orgId || typeof window.Visitor?.getInstance !== 'function') return;
    try {
      visitor = window.Visitor.getInstance(orgId);
    } catch (e) {
      visitor = null;
    }
  }

  function identity() {
    // ECID wins when at.js has established one, otherwise our own first-party id.
    try {
      const ecid = visitor?.getMarketingCloudVisitorID?.();
      if (ecid) return { mid: ecid };
    } catch (e) { /* fall through */ }
    const vid = getFallbackVisitorId();
    return vid ? { vid } : {};
  }

  function sendBeacon(translated) {
    const params = {
      AQB: 1,
      ndh: 1,
      t: timestampParam(),
      ce: 'UTF-8',
      cc: 'USD',
      s: `${window.screen.width}x${window.screen.height}`,
      bw: window.innerWidth,
      bh: window.innerHeight,
      ...(document.referrer ? { r: document.referrer } : {}),
      ...toQueryParams(translated.vars),
      ...identity(),
    };
    if (!translated.isPageView) {
      params.pe = `lnk_${translated.linkType}`;
      params.pev2 = translated.linkName;
      params.pev1 = translated.linkURL;
    }

    const query = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const cacheBuster = `s${Date.now()}${Math.floor(Math.random() * 100000000)}`;
    const url = `https://${trackingServer}/b/ss/${reportSuiteId}/1/${JS_VERSION}/${cacheBuster}?${query}&AQE=1`;

    lastHit = url;
    // A GET image request is the documented Analytics collection method and is
    // not blocked by CORS, unlike fetch() against the collection endpoint.
    const img = new Image();
    img.src = url;
  }

  function sendViaLibrary(translated) {
    s.clearVars();
    Object.assign(s, translated.vars);
    if (translated.isPageView) s.t();
    else s.tl(true, translated.linkType, translated.linkName);
  }

  return {
    name: 'appmeasurement',

    async init() {
      if (!reportSuiteId || !trackingServer) {
        // eslint-disable-next-line no-console
        console.warn('[analytics] appmeasurement: reportSuiteId / trackingServer not configured');
        return false;
      }

      attachVisitor();

      // Try the real library; fall back to the built-in beacon if it isn't there.
      try {
        if (!window.s_gi && appMeasurementUrl) await loadScript(appMeasurementUrl);
        if (typeof window.s_gi === 'function') {
          s = window.s_gi(reportSuiteId);
          s.account = reportSuiteId;
          s.trackingServer = trackingServer;
          s.trackingServerSecure = trackingServer;
          s.charSet = 'UTF-8';
          s.currencyCode = 'USD';
          s.trackExternalLinks = false; // we emit our own, block-aware link events
          s.trackDownloadLinks = false;
          if (visitor) s.visitor = visitor;
          window.s = s;
          mode = 'library';
        }
      } catch (e) {
        mode = 'beacon';
      }

      // eslint-disable-next-line no-console
      console.info(
        `%c[analytics] Adobe Analytics active%c — report suite "${reportSuiteId}" via ${trackingServer} (${mode} mode)`,
        'color:#d10411;font-weight:700',
        'color:inherit',
      );
      return true;
    },

    /** @returns {string|null} the last collection URL, for demos and QA */
    get lastHit() {
      return lastHit;
    },

    send(entry) {
      if (!entry?.event || entry.event === 'consent-update') return;
      const translated = toAnalyticsVars(entry);
      if (mode === 'library' && s) sendViaLibrary(translated);
      else sendBeacon(translated);
    },
  };
}
