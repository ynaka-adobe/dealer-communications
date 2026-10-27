import { shouldShowAnnouncement } from './communications-data.js';
import { listCommunications, watchCommunications } from '../../scripts/communications-api.js';
import showAnnouncement from './announcement.js';
import { downloadHtml, downloadPdf } from '../../scripts/communication-export.js';
import { runReview, toast } from '../../scripts/review-dialog.js';

const PAGE_SIZE = 10;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

const ACTIVE_COLUMNS = [
  { key: 'title', label: 'Title', sort: true, filter: true },
  { key: 'status', label: 'Status', sort: true, filter: true, select: true },
  { key: 'reviewer', label: 'Reviewer', sort: true, filter: true, select: true },
  { key: 'author', label: 'Author', sort: true, filter: true, select: true },
  { key: 'created', label: 'Created Date', sort: true, date: true },
  { key: 'modified', label: 'Modified Date', sort: true, date: true },
];

const ARCHIVE_COLUMNS = [
  {
    key: 'fileName', label: 'File Name', sort: true, filter: true, info: true,
  },
  { key: 'title', label: 'Title', sort: true, filter: true },
  { key: 'status', label: 'Status', sort: true, filter: true, select: true },
  { key: 'reviewer', label: 'Reviewer', sort: true, filter: true, select: true },
  { key: 'author', label: 'Author', sort: true, filter: true, select: true },
  { key: 'created', label: 'Created Date', sort: true, date: true },
  { key: 'modified', label: 'Modified Date', sort: true, date: true },
];

// A reference only means something for real communication numbers (EFC260061); the id the
// site gives a draft (DRAFT-<time>-<code>) is plumbing, so it is not shown.
const SITE_ID = /^DRAFT-\d{14}-[a-z0-9]{4}$/;

// workflow order for the Status list; any other value sorts after these, alphabetically
const STATUS_ORDER = ['DRAFT', 'REVIEWER PENDING', 'FINAL APPROVAL PENDING', 'GENERATING PDF', 'PDF ERROR', 'APPROVED', 'PUBLISHED', 'ARCHIVED', 'UNPUBLISH'];

// Text search: each cell is folded to lower case without accents and split into words once per
// row set (the "index"). A query matches when every query word starts a word of the cell, in any
// order; a substring hit inside a word still counts, but ranks lower.
const fold = (v) => String(v == null ? '' : v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const wordsOf = (folded) => folded.split(/[^a-z0-9]+/).filter(Boolean);

function buildIndex(rows, keys) {
  const index = new Map();
  rows.forEach((r) => {
    const entry = {};
    keys.forEach((k) => { const text = fold(r[k]); entry[k] = { text, words: wordsOf(text) }; });
    index.set(r, entry);
  });
  return index;
}

/** 0 = no match, 3 = whole phrase at the start, 2 = every word starts a word, 1 = substrings only */
function score(cell, query) {
  const terms = wordsOf(query);
  if (!terms.length) return 3;
  if (cell.text.startsWith(query)) return 3;
  if (terms.every((t) => cell.words.some((w) => w.startsWith(t)))) return 2;
  return terms.every((t) => cell.text.includes(t)) ? 1 : 0;
}

const ACTIONS = ['Edit', 'Preview', 'Download PDF', 'Download HTML', 'Archive'];

// the next workflow step offered for a status (demo review actions; see scripts/review-dialog.js)
const NEXT_STEP = {
  DRAFT: ['Send to Reviewer', 'reviewer'],
  'REVIEWER PENDING': ['Final Approval', 'final'],
  'FINAL APPROVAL PENDING': ['Approve', 'approve'],
  'PDF ERROR': ['Retry PDF', 'approve'],
};
// Edit is offered for a draft made on the site while it is a draft or in review
const EDITABLE_STATUS = ['DRAFT', 'REVIEWER PENDING'];
// what the page says the moment an action is chosen, while the service works (it takes a few seconds)
const REVIEW_PROGRESS = {
  reviewer: 'Sending to the reviewer', final: 'Moving to final approval', approve: 'Starting the PDF', reopen: 'Reopening', archive: 'Archiving', restore: 'Restoring',
};
const REVIEW_DONE = {
  reviewer: 'sent to the reviewer', final: 'moved to final approval', approve: 'published', reopen: 'reopened as a draft', archive: 'moved to the archive', restore: 'moved back to Home',
};
const statusClass = (s) => `status-${String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
const ARCHIVE_ACTIONS = ['Copy As New', 'Preview', 'Download PDF', 'Download HTML', 'Restore', 'Reopen', 'View Properties', 'Version'];

function formatDate(iso) {
  const d = new Date(iso);
  return `${pad(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export default async function decorate(block) {
  const isArchive = block.classList.contains('archive');

  const menuActions = isArchive ? ARCHIVE_ACTIONS : ACTIONS;
  let rows;
  try {
    rows = await listCommunications(isArchive ? 'archive' : 'active');
  } catch (e) {
    // the service answers 401 when the session has ended; anything else is a service problem
    const signedOut = /communications api 401/.test(e && e.message);
    block.textContent = '';
    const msg = el('p', 'communications-error');
    if (signedOut) {
      const link = el('a', '', 'Sign in');
      link.href = `/auth/login?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`;
      msg.append('Your session has ended. ', link, ' to see communications.');
    } else {
      msg.textContent = 'Communications are unavailable right now. Please try again shortly.';
    }
    block.append(msg);
    return;
  }
  // the File Name column only when some communication has a real number, so both pages share
  // one layout; a locked communication is marked next to its title
  const COLUMNS = (isArchive ? ARCHIVE_COLUMNS : ACTIVE_COLUMNS)
    .filter((c) => c.key !== 'fileName' || rows.some((r) => r.fileName && !SITE_ID.test(r.fileName)));
  const leadCount = 1;
  const state = {
    sortKey: null, sortDir: 1, filters: {}, page: 1, tallest: 0,
  };

  block.textContent = '';

  // header band: breadcrumb on the left, actions on the right, the same on both pages
  const toolbar = el('div', 'communications-toolbar');
  if (!isArchive) {
    const archive = el('a', 'communications-button', 'View Archive');
    archive.href = '/archive';
    toolbar.append(archive);
  }
  const analytics = el('a', 'communications-button', 'Analytics');
  analytics.href = 'https://www5.an.adobe.com/spa/?linkId=22922960-fc03-4979-90de-d361fa904a4b&dpc=pnw';
  analytics.target = '_blank';
  analytics.rel = 'noopener noreferrer';
  toolbar.append(analytics);
  const create = el('button', 'communications-button', 'Create Draft');
  create.type = 'button';
  create.addEventListener('click', async () => {
    const proceed = block.dispatchEvent(new CustomEvent('communications:create-draft', { bubbles: true, cancelable: true }));
    if (!proceed) return;
    if (shouldShowAnnouncement() && !(await showAnnouncement())) return;
    window.location.href = '/create-draft';
  });
  toolbar.append(create);
  // the archive page authors its own "Home › View Archive"; the home page is just "Home"
  let crumb = document.querySelector('main .breadcrumb');
  if (!crumb) {
    crumb = el('nav', 'breadcrumb');
    crumb.setAttribute('aria-label', 'Breadcrumb');
    const here = el('h1', '', 'Home');
    here.setAttribute('aria-current', 'page');
    crumb.append(here);
  }
  const bar = el('div', 'communications-bar');
  bar.append(crumb, toolbar);

  // table
  const table = el('table');
  const scroller = el('div', 'communications-scroll');
  const thead = el('thead');
  const tbody = el('tbody');
  table.append(thead, tbody);
  const pager = el('nav', 'communications-pager');
  pager.setAttribute('aria-label', 'Pagination');

  const searchKeys = COLUMNS.filter((c) => c.filter && !c.select).map((c) => c.key);
  let index = buildIndex(rows, searchKeys);

  function visibleRows() {
    const best = new Map(); // row -> its weakest search score, for ranking
    let out = rows.filter((r) => Object.entries(state.filters).every(([k, v]) => {
      if (!v) return true;
      if (COLUMNS.find((c) => c.key === k).select) return String(r[k]) === v;
      const hit = score(index.get(r)[k], fold(v).trim());
      best.set(r, Math.min(best.get(r) || 3, hit));
      return hit > 0;
    }));
    if (state.sortKey) {
      out = [...out].sort((a, b) => (a[state.sortKey] > b[state.sortKey] ? 1 : -1) * state.sortDir);
    } else if (best.size) {
      // no explicit sort: best matches first, otherwise the sheet's own order
      out = out.map((r, i) => [r, i]).sort((a, b) => (best.get(b[0]) - best.get(a[0])) || (a[1] - b[1])).map(([r]) => r);
    }
    return out;
  }

  // the choices of a drop-down are the values currently in the sheet
  const selects = {};
  function optionsFor(key) {
    const values = [...new Set(rows.map((r) => String(r[key] || '')).filter((v) => v && v !== '-'))];
    if (key !== 'status') return values.sort((a, b) => a.localeCompare(b));
    const rank = (v) => (STATUS_ORDER.includes(v) ? STATUS_ORDER.indexOf(v) : STATUS_ORDER.length);
    return values.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }
  function fillSelect(select, key, label) {
    const keep = state.filters[key] || '';
    select.textContent = '';
    const all = el('option', '', `Any ${label.toLowerCase()}`);
    all.value = '';
    select.append(all);
    const values = optionsFor(key);
    // a selected value that has left the sheet stays selectable until the person changes it
    if (keep && !values.includes(keep)) values.push(keep);
    values.forEach((v) => {
      const o = el('option', '', v);
      o.value = v;
      select.append(o);
    });
    select.value = keep;
  }

  // A refresh can read a copy of the sheet from just before a change made here, so for a short
  // while the page keeps the result it already knows: id -> { status, gone, until }
  const settled = new Map();
  const SETTLE_MS = 45000;
  function applySettled(list) {
    const now = Date.now();
    settled.forEach((v, id) => { if (v.until < now) settled.delete(id); });
    return list.filter((r) => !(settled.get(r.id) || {}).gone)
      .map((r) => (settled.has(r.id) ? { ...r, status: settled.get(r.id).status } : r));
  }

  const busy = new Set(); // records with an action in progress

  async function review(r, action) {
    if (busy.has(r.id)) return; // one action at a time per row
    // feedback at once: the row dims with a spinner and a message says what is happening
    busy.add(r.id);
    renderBody();
    const working = toast(`${REVIEW_PROGRESS[action] || 'Working'}: \u201C${r.title}\u201D\u2026`, 'progress');
    try {
      const out = await runReview(r.id, action);
      // approving starts PDF generation; the row leaves this list only once it is APPROVED
      // approving starts PDF generation and stays here; archiving, restoring and reopening move it to the other list
      const gone = ['archive', 'restore', 'reopen'].includes(action);
      settled.set(r.id, { status: out.status, gone, until: Date.now() + SETTLE_MS });
      if (gone) {
        // it now belongs on the other list; this one drops it at once
        rows = rows.filter((x) => x.id !== r.id);
      } else {
        r.status = out.status;
      }
      index = buildIndex(rows, searchKeys);
      Object.entries(selects).forEach(([key, { select, label }]) => fillSelect(select, key, label));
      renderBody();
      toast(out.status === 'GENERATING PDF'
        ? `Generating the PDF for "${r.title}". It shows as Published when it is ready.`
        : `"${r.title}" ${REVIEW_DONE[action]}.`);
    } catch (e) {
      // a server failure may still have saved the change, so say to check the list before trying again
      toast(e.status >= 500 || !e.status ? 'That did not go through (the service did not answer). Check the list, then try again.' : e.message, 'error');
    } finally {
      working.remove();
      busy.delete(r.id);
      renderBody();
    }
  }

  function closeMenus() {
    block.querySelectorAll('.communications-menu').forEach((m) => m.remove());
  }

  function renderBody() {
    closeMenus();
    const all = visibleRows();
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages);
    const slice = all.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);

    tbody.textContent = '';
    if (!slice.length) {
      const tr = el('tr');
      const td = el('td', 'communications-empty', 'No communications found');
      td.colSpan = COLUMNS.length + leadCount;
      tr.append(td);
      tbody.append(tr);
    }
    slice.forEach((r) => {
      const tr = el('tr');
      if (busy.has(r.id)) { tr.classList.add('communications-busy'); tr.setAttribute('aria-busy', 'true'); }
      const actions = el('td', 'communications-actions');
      // review steps only exist for communications that live in AEM (they have an asset path)
      const step = !isArchive && r.aemPath && NEXT_STEP[r.status];
      // a PDF can only be downloaded when one was exported for this communication
      // a published communication stays on Home (nothing archives it by itself), so it needs the
      // same viewing actions as the archive, plus Archive (status ARCHIVED); Restore brings it back
      const published = r.aemPath && r.status === 'PUBLISHED';
      const items = (isArchive ? menuActions : [menuActions[0], ...(step ? [step[0]] : []), ...menuActions.slice(1)])
        .filter((a) => {
          if (a === 'Edit') return r.aemPath && SITE_ID.test(r.id) && EDITABLE_STATUS.includes(r.status);
          if (a === 'Preview' || a === 'Download HTML') return isArchive || published;
          if (a === 'Download PDF') return r.pdf && (isArchive || published);
          if (a === 'Archive') return published;
          if (a === 'Restore') return r.aemPath && r.status === 'ARCHIVED';
          if (a === 'Reopen') return r.aemPath;
          if (a === 'Copy As New') return r.aemPath; // only a communication that lives in AEM can be copied
          return true;
        });
      const kebab = el('button', 'communications-kebab', '⋮');
      kebab.type = 'button';
      kebab.setAttribute('aria-label', `Actions for ${r.title}`);
      kebab.dataset.analyticsLabel = 'Row actions'; // analytics reports this, never the record's title
      kebab.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = actions.querySelector('.communications-menu');
        closeMenus();
        if (open) return;
        const menu = el('ul', 'communications-menu');
        items.forEach((a) => {
          const li = el('li');
          const item = el('button', '', a);
          item.type = 'button';
          item.addEventListener('click', () => {
            closeMenus();
            const proceed = block.dispatchEvent(new CustomEvent(`communications:${a.toLowerCase().replace(/\s+/g, '-')}`, { bubbles: true, cancelable: true, detail: r }));
            if (!proceed) return;
            if (!isArchive && a === 'Edit') window.location.href = `/create-draft?edit=${encodeURIComponent(r.id)}`;
            if (a === 'Copy As New') window.location.href = `/create-draft?copy=${encodeURIComponent(r.id)}`;
            if (a === 'Preview') window.location.href = `/preview?file=${encodeURIComponent(r.fileName)}`;
            if (a === 'Download PDF') downloadPdf(r.pdf, r.fileName);
            if (a === 'Download HTML') downloadHtml(r.fileName);
            const action = (step && a === step[0] && step[1])
              || ({ Reopen: 'reopen', Archive: 'archive', Restore: 'restore' })[a];
            if (action) review(r, action);
          });
          li.append(item);
          menu.append(li);
        });
        actions.append(menu);
        // fixed positioning escapes the table's scroll container; flip up near the bottom edge
        const k = kebab.getBoundingClientRect();
        const m = menu.getBoundingClientRect();
        const below = k.bottom + m.height + 8 <= window.innerHeight;
        menu.style.top = `${below ? k.bottom : Math.max(8, k.top - m.height)}px`;
        menu.style.left = `${Math.min(k.left, window.innerWidth - m.width - 8)}px`;
      });
      // a row with no actions (for example a draft that was saved but never submitted) shows no menu
      if (busy.has(r.id)) {
        const spin = el('span', 'review-spinner');
        spin.setAttribute('role', 'img');
        spin.setAttribute('aria-label', 'Working');
        actions.append(spin);
      } else if (items.length) actions.append(kebab);
      tr.append(actions);
      COLUMNS.forEach((c) => {
        let text = r[c.key];
        if (c.date) text = formatDate(r[c.key]);
        else if (c.key === 'status') text = '';
        else if (c.key === 'fileName' && SITE_ID.test(r.fileName)) text = '\u2014';
        const td = el('td', c.date ? 'communications-date' : '', text);
        if (c.key === 'title' && r.locked) {
          const lock = el('span', 'communications-info', '\u24D8 ');
          lock.title = 'Locked';
          lock.setAttribute('role', 'img');
          lock.setAttribute('aria-label', 'Locked');
          td.prepend(lock);
        }
        if (c.key === 'status') {
          const pill = el('span', `communications-status ${statusClass(r.status)}`, r.status);
          if (r.note) pill.title = r.note; // why a PDF failed
          td.append(pill);
        }
        if (c.info && !SITE_ID.test(r.fileName)) {
          const i = el('span', 'communications-info', ' \u24D8');
          i.title = `Details for ${r[c.key]}`;
          td.append(i);
        }
        tr.append(td);
      });
      tbody.append(tr);
    });

    // keep the table as tall as its fullest page so the pager does not jump up on a short page
    state.tallest = Math.max(state.tallest, table.offsetHeight);
    scroller.style.minHeight = state.tallest ? `${state.tallest}px` : '';

    // pagination
    pager.textContent = '';
    const addPage = (label, page, { current = false, disabled = false, aria } = {}) => {
      const b = el('button', current ? 'current' : '', label);
      b.type = 'button';
      b.disabled = disabled;
      if (aria) b.setAttribute('aria-label', aria);
      if (current) b.setAttribute('aria-current', 'page');
      b.addEventListener('click', () => { state.page = page; renderBody(); });
      pager.append(b);
    };
    addPage('«', 1, { disabled: state.page === 1, aria: 'First page' });
    addPage('‹', state.page - 1, { disabled: state.page === 1, aria: 'Previous page' });
    for (let p = 1; p <= pages; p += 1) addPage(String(p), p, { current: p === state.page });
    addPage('›', state.page + 1, { disabled: state.page === pages, aria: 'Next page' });
    addPage('»', pages, { disabled: state.page === pages, aria: 'Last page' });
  }

  function renderHead() {
    thead.textContent = '';
    const labels = el('tr');
    const filters = el('tr', 'communications-filters');
    labels.append(el('th', '', 'Actions'));
    filters.append(el('th'));
    COLUMNS.forEach((c) => {
      const th = el('th');
      th.setAttribute('scope', 'col');
      if (c.sort) {
        const b = el('button', 'communications-sort', c.label);
        b.type = 'button';
        const arrow = state.sortKey === c.key ? (state.sortDir > 0 ? ' ↑' : ' ↓') : ' ⇅';
        b.append(el('span', 'communications-arrow', arrow));
        b.addEventListener('click', () => {
          state.sortDir = state.sortKey === c.key ? -state.sortDir : 1;
          state.sortKey = c.key;
          renderHead();
          renderBody();
        });
        th.append(b);
        th.setAttribute('aria-sort', state.sortKey === c.key ? (state.sortDir > 0 ? 'ascending' : 'descending') : 'none');
      } else {
        th.textContent = c.label;
      }
      labels.append(th);

      const fth = el('th');
      if (c.select) {
        const select = el('select');
        select.setAttribute('aria-label', `Filter by ${c.label}`);
        selects[c.key] = { select, label: c.label };
        fillSelect(select, c.key, c.label);
        select.addEventListener('change', () => {
          state.filters[c.key] = select.value;
          state.page = 1;
          renderBody();
        });
        fth.append(select);
      } else if (c.filter) {
        const input = el('input');
        input.type = 'search';
        input.placeholder = `Search by ${c.label}`;
        input.setAttribute('aria-label', `Search by ${c.label}`);
        input.value = state.filters[c.key] || '';
        input.addEventListener('input', () => {
          state.filters[c.key] = input.value;
          state.page = 1;
          renderBody();
        });
        fth.append(input);
      }
      filters.append(fth);
    });
    thead.append(labels, filters);
  }

  document.addEventListener('click', closeMenus);
  window.addEventListener('scroll', closeMenus, true);
  window.addEventListener('resize', closeMenus);
  // row heights change with the width (titles wrap), so measure again after a resize
  window.addEventListener('resize', () => { state.tallest = 0; scroller.style.minHeight = ''; });
  renderHead();
  renderBody();
  // pick up workflow status changes made in AEM (remote backend only)
  watchCommunications(isArchive ? 'archive' : 'active', (fresh) => {
    rows = applySettled(fresh);
    index = buildIndex(rows, searchKeys);
    Object.entries(selects).forEach(([key, { select, label }]) => fillSelect(select, key, label));
    renderBody();
  });
  scroller.append(table);
  block.append(bar, scroller, pager);
}
