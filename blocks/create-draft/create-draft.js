import {
  CHANNELS, DEALER_GROUPS, DEALER_ROLES, DEPARTMENTS, DIVISIONS, FIELD_GROUPS, FIELD_ROLES,
  ROUTING,
} from './create-draft-data.js';
import {
  createDraft, saveDraftStep, loadDraftForEdit, loadDraftForCopy, updateDraft,
} from '../../scripts/communications-api.js';
import { sanitizeHtml, richText } from './rich-text.js';
import trackEvent from '../../scripts/analytics-events.js';

const STEPS = 4;
const DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const isDealer = (s) => s.dealerComm === 'Yes';

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : DATE_FMT.format(d);
}

function dealerPublishDate(s) {
  // sample rule: dealers are told the day after the field
  if (!s.fieldPublish) return '';
  const d = new Date(s.fieldPublish);
  d.setDate(d.getDate() + 1);
  return DATE_FMT.format(d);
}

/* ---------- field builders ---------- */

function wrap(label, required, control, note) {
  const f = el('div', 'cd-field');
  const l = el('label', 'cd-label');
  if (required) l.append(el('span', 'cd-req', '*'));
  l.append(label);
  if (note) {
    const i = el('span', 'cd-info', ' ⓘ');
    i.title = note;
    l.append(i);
  }
  f.append(l, control, el('p', 'cd-error'));
  if (control.id) l.htmlFor = control.id;
  f.dataset.required = required ? 'true' : 'false';
  return f;
}

let uid = 0;
const nextId = () => { uid += 1; return `cd-${uid}`; };

function textField(state, key, label, { required, readonly, placeholder } = {}) {
  const input = el('input', 'cd-input');
  input.id = nextId();
  input.type = 'text';
  input.value = state[key] || '';
  if (placeholder) input.placeholder = placeholder;
  if (readonly) { input.readOnly = true; input.classList.add('cd-readonly'); }
  input.addEventListener('input', () => { state[key] = input.value; });
  return wrap(label, required, input);
}

function selectField(state, key, label, options, { required, placeholder, onChange } = {}) {
  const sel = el('select', 'cd-input');
  sel.id = nextId();
  sel.append(new Option(placeholder || '', ''));
  options.forEach((o) => sel.append(new Option(o, o)));
  sel.value = state[key] || '';
  sel.addEventListener('change', () => {
    state[key] = sel.value;
    if (onChange) onChange(sel.value);
  });
  return wrap(label, required, sel);
}

/** How the PDF looks: a choice of styles, each backed by its own Guides preset. */
function pdfStyleField(state) {
  const sel = el('select', 'cd-input');
  sel.id = nextId();
  [['dealer', 'Dealer Communications'], ['adobe', 'Adobe']].forEach(([value, text]) => sel.append(new Option(text, value)));
  sel.value = state.pdfStyle === 'adobe' ? 'adobe' : 'dealer';
  state.pdfStyle = sel.value;
  sel.addEventListener('change', () => { state.pdfStyle = sel.value; });
  return wrap('PDF Style', false, sel);
}

function dateField(state, key, label, { required, time, note } = {}) {
  const row = el('div', 'cd-date');
  const input = el('input', 'cd-input');
  input.id = nextId();
  input.type = time ? 'datetime-local' : 'date';
  input.value = state[key] || '';
  input.addEventListener('input', () => { state[key] = input.value; });
  const clear = el('button', 'cd-link', 'Clear Date');
  clear.type = 'button';
  clear.addEventListener('click', () => { input.value = ''; state[key] = ''; });
  row.append(input, clear);
  const f = wrap(label, required, row, note);
  f.querySelector('label').htmlFor = input.id;
  return f;
}

function checkGroup(state, key, label, options, { columns } = {}) {
  const group = el('div', 'cd-field');
  group.append(el('p', 'cd-label', label));
  const list = el('div', 'cd-checks');
  if (columns) list.style.setProperty('--cd-cols', columns);
  state[key] = state[key] || [];
  options.forEach((o) => {
    const l = el('label', 'cd-check');
    const c = el('input');
    c.type = 'checkbox';
    c.checked = state[key].includes(o);
    c.addEventListener('change', () => {
      state[key] = c.checked ? [...state[key], o] : state[key].filter((v) => v !== o);
    });
    l.append(c, o);
    list.append(l);
  });
  group.append(list);
  return group;
}

/* ---------- steps ---------- */

function step1(state) {
  const box = el('div', 'cd-card cd-narrow');
  const reviewer = textField(state, 'reviewer', 'Reviewer User ID', { readonly: true });
  const alternate = textField(state, 'alternate', 'Alternate Reviewer User ID', { readonly: true });
  const concurring = textField(state, 'concurring', 'Concurring Manager', { required: true, readonly: true });
  const fill = (channel) => {
    const r = ROUTING[channel] || ROUTING.default;
    Object.assign(state, { reviewer: r.reviewer, alternate: r.alternate, concurring: r.concurring });
    reviewer.querySelector('input').value = r.reviewer;
    alternate.querySelector('input').value = r.alternate;
    concurring.querySelector('input').value = r.concurring;
  };
  box.append(
    selectField(state, 'division', 'Originating Divisions', DIVISIONS, { required: true, placeholder: 'Select Division' }),
    checkGroup(state, 'additionalDivisions', 'Additional Divisions', DIVISIONS),
    selectField(state, 'channel', 'Channel', CHANNELS, { required: true, placeholder: 'Select Channel', onChange: fill }),
    reviewer,
    alternate,
    concurring,
    textField(state, 'originator', 'Originator User ID', { required: true, readonly: true }),
    textField(state, 'businessContact', 'Business Contact', { required: true }),
  );
  return box;
}

function step2(state, rerender) {
  const box = el('div', 'cd-card cd-narrow');
  box.append(
    textField(state, 'title', 'Communication Title', { required: true, placeholder: 'Enter Communication Title' }),
    dateField(state, 'fieldPublish', 'Field Publish Date', { required: true, time: true }),
    dateField(state, 'fieldDue', 'Field Due Date', { note: 'Date by which the field must complete the action' }),
    dateField(state, 'dealerDue', 'Dealer Action Due Date'),
    pdfStyleField(state),
  );
  box.append(el('hr', 'cd-rule'));
  const radio = el('div', 'cd-field');
  radio.dataset.required = 'true';
  const q = el('p', 'cd-label');
  q.append(el('span', 'cd-req', '*'), ' Is this a Dealer Communication in addition to a Field Communication');
  radio.append(q);
  ['Yes', 'No'].forEach((v) => {
    const l = el('label', 'cd-radio');
    const r = el('input');
    r.type = 'radio';
    r.name = 'dealerComm';
    r.checked = state.dealerComm === v;
    r.addEventListener('change', () => { state.dealerComm = v; rerender(false); });
    l.append(r, v);
    radio.append(l);
  });
  radio.append(el('p', 'cd-error'));
  box.append(radio);
  return box;
}

/** Three-column role picker: drag items between lists, or press Enter to move to the next list. */
function rolePicker(state) {
  state.fieldLead = state.fieldLead || [];
  state.fieldSupport = state.fieldSupport || [];
  const cols = [
    { key: null, title: 'Field Role Selections' },
    { key: 'fieldLead', title: 'Field Lead' },
    { key: 'fieldSupport', title: 'Field Support' },
  ];
  const wrapEl = el('div', 'cd-picker');
  const available = () => FIELD_ROLES.filter((r) => !state.fieldLead.includes(r) && !state.fieldSupport.includes(r));
  const items = (col) => (col.key ? state[col.key] : available());

  function move(role, toKey) {
    state.fieldLead = state.fieldLead.filter((r) => r !== role);
    state.fieldSupport = state.fieldSupport.filter((r) => r !== role);
    if (toKey) state[toKey] = [...state[toKey], role];
    // eslint-disable-next-line no-use-before-define
    draw();
  }

  function draw() {
    wrapEl.textContent = '';
    cols.forEach((col, i) => {
      const c = el('div', 'cd-col');
      const h = el('p', 'cd-col-title', col.title);
      h.append(el('span', 'cd-info', ' ⓘ'));
      const list = el('ul', 'cd-list');
      list.dataset.key = col.key || '';
      items(col).forEach((role) => {
        const li = el('li', 'cd-item', role);
        li.draggable = true;
        li.tabIndex = 0;
        li.title = 'Drag to another list, or press Enter to move to the next list';
        li.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', role));
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') move(role, cols[(i + 1) % cols.length].key);
        });
        list.append(li);
      });
      list.addEventListener('dragover', (e) => e.preventDefault());
      list.addEventListener('drop', (e) => {
        e.preventDefault();
        const role = e.dataTransfer.getData('text/plain');
        if (FIELD_ROLES.includes(role)) move(role, col.key);
      });
      c.append(h, list);
      wrapEl.append(c);
    });
  }
  draw();
  return wrapEl;
}

function step3(state) {
  const box = el('div', 'cd-card');
  const title = textField(state, 'title', 'Communication Title', { readonly: true });
  title.classList.add('cd-narrow');
  const group = selectField(state, 'fieldGroup', 'Target Field Group', FIELD_GROUPS, { required: true });
  group.classList.add('cd-narrow');
  box.append(title, group, rolePicker(state));
  if (isDealer(state)) {
    const dg = selectField(state, 'dealerGroup', 'Target Dealer Group', DEALER_GROUPS, { required: true });
    dg.classList.add('cd-narrow');
    const dept = selectField(state, 'primaryDept', 'Primary Dealer Department', DEPARTMENTS, { required: true, placeholder: 'Select Department' });
    dept.classList.add('cd-narrow');
    box.append(
      dg,
      checkGroup(state, 'dealerRoles', 'Target Dealer Roles', DEALER_ROLES),
      dept,
      checkGroup(state, 'additionalDepts', 'Additional Target Departments', DEPARTMENTS),
    );
  }
  return box;
}

function attachments(state, key, heading) {
  const sec = el('section', 'cd-attach');
  sec.append(el('h2', '', heading));
  const card = el('div', 'cd-card cd-attach-card');
  const names = el('div', 'cd-attach-names');
  state[key] = state[key] || [];
  const draw = () => {
    names.textContent = '';
    if (!state[key].length) names.append(el('span', 'cd-muted', 'File Name'));
    state[key].forEach((f, i) => {
      const row = el('span', 'cd-file', f.name);
      const rm = el('button', 'cd-link', 'Remove');
      rm.type = 'button';
      rm.addEventListener('click', () => { state[key].splice(i, 1); draw(); });
      row.append(rm);
      names.append(row);
    });
  };
  const input = el('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  input.addEventListener('change', () => { state[key].push(...input.files); input.value = ''; draw(); });
  const add = el('button', 'cd-btn cd-btn-blue', 'Add Attachment');
  add.type = 'button';
  add.addEventListener('click', () => input.click());
  draw();
  card.append(names, add, input);
  sec.append(card);
  return sec;
}

function step4(state) {
  const frag = el('div', 'cd-step4');
  const fieldCard = el('div', 'cd-card');
  fieldCard.append(richText(state, 'fieldOnly', 'Field Only Information'));
  frag.append(fieldCard, attachments(state, 'fieldFiles', 'Field Attachments'));
  if (isDealer(state)) {
    frag.append(el('h2', '', 'Dealer Communication'));
    const card = el('div', 'cd-card');
    card.append(richText(state, 'action', 'Action Requested', { required: true }));
    card.append(richText(state, 'summary', 'Summary', { required: true }));
    state.extraSections = state.extraSections || [];
    const extras = el('div', 'cd-extras');
    const drawExtras = () => {
      extras.textContent = '';
      state.extraSections.forEach((sec, i) => {
        const w = el('div', 'cd-extra');
        const t = el('input', 'cd-input');
        t.placeholder = 'Section title';
        t.value = sec.title || '';
        t.addEventListener('input', () => { sec.title = t.value; });
        const rm = el('button', 'cd-link', 'Remove Section');
        rm.type = 'button';
        rm.addEventListener('click', () => { state.extraSections.splice(i, 1); drawExtras(); });
        w.append(t, rm, richText(sec, 'html', 'Section Content'));
        extras.append(w);
      });
    };
    drawExtras();
    const add = el('button', 'cd-link cd-add', '⊕ Add Additional Section');
    add.type = 'button';
    add.addEventListener('click', () => { state.extraSections.push({ title: '', html: '' }); drawExtras(); });
    card.append(el('hr', 'cd-rule'), add, extras, el('hr', 'cd-rule'), richText(state, 'questions', 'Questions', { required: true }));
    frag.append(card, attachments(state, 'dealerFiles', 'Dealer Attachments'));
  }
  return frag;
}

/* ---------- preview ---------- */

function previewPane(state, mode) {
  const layout = el('div', 'cd-preview');
  const side = el('aside', 'cd-card');
  const rows = mode === 'field' ? [
    ['Field Publish Date', formatDate(state.fieldPublish)],
    ['Target Field Group', state.fieldGroup],
    ['Field Lead', (state.fieldLead || []).join(', ')],
    ['Field Support', (state.fieldSupport || []).join(', ')],
    ...(isDealer(state) ? [
      ['Dealer Publish Date', dealerPublishDate(state)],
      ['Target Group', state.dealerGroup],
      ['Target Roles', (state.dealerRoles || []).join(', ')],
      ['Target Department', [state.primaryDept, ...(state.additionalDepts || [])].filter(Boolean).join(', ')],
    ] : []),
  ] : [
    ['Dealer Publish Date', dealerPublishDate(state)],
    ['Target Group', state.dealerGroup],
    ['Target Roles', (state.dealerRoles || []).join(', ')],
    ['Target Department', [state.primaryDept, ...(state.additionalDepts || [])].filter(Boolean).join(', ')],
  ];
  rows.forEach(([k, v]) => {
    const r = el('div', 'cd-pfield');
    r.append(el('p', 'cd-plabel', k), el('p', '', v || '—'));
    side.append(r);
  });
  const main = el('article', 'cd-card cd-pbody');
  main.append(el('h1', '', state.title || 'Untitled'));
  const section = (heading, html, rule) => {
    const s = el('div', 'cd-psection');
    s.append(el('h3', '', heading));
    const body = el('div', 'cd-pcontent');
    body.innerHTML = sanitizeHtml(html) || '<p>—</p>';
    s.append(body);
    main.append(s);
    if (rule) main.append(el('hr', 'cd-dotted'));
  };
  if (mode === 'field') section('Field Only Information', state.fieldOnly, isDealer(state));
  if (isDealer(state)) {
    section('Action Requested', state.action);
    section('Summary', state.summary);
    (state.extraSections || []).forEach((x) => section(x.title || 'Additional Section', x.html));
    section('Questions', state.questions);
  }
  layout.append(side, main);
  return layout;
}

/* ---------- wizard ---------- */

function validate(root) {
  let first = null;
  root.querySelectorAll('.cd-field[data-required="true"]').forEach((f) => {
    const control = f.querySelector('[contenteditable]') || f.querySelector('input:not([type=radio]):not([type=checkbox]), select');
    const radios = f.querySelectorAll('input[type=radio]');
    let ok = true;
    if (radios.length) ok = [...radios].some((r) => r.checked);
    else if (control && control.isContentEditable) ok = control.textContent.trim().length > 0;
    else if (control) ok = control.value.trim().length > 0;
    f.classList.toggle('cd-invalid', !ok);
    f.querySelector('.cd-error').textContent = ok ? '' : 'This field is required';
    if (!ok && !first) first = control || radios[0];
  });
  if (first) first.focus();
  return !first;
}

function stepper(current) {
  const s = el('ol', 'cd-stepper');
  for (let i = 1; i <= STEPS; i += 1) {
    const li = el('li', i === current ? 'active' : '', String(i));
    if (i === current) li.setAttribute('aria-current', 'step');
    s.append(li);
  }
  return s;
}

export default async function decorate(block) {
  const state = {
    step: 1,
    dealerComm: '',
    originator: 'sgorle1',
    businessContact: 'sgorle1',
    // id for this draft: names its saved progress and ties it to the AEM asset on submit
    draftId: `DRAFT-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`,
  };

  /** Form state as plain data (attachment files become their names). */
  const snapshot = () => {
    const out = JSON.parse(JSON.stringify(state, (k, v) => (k === 'fieldFiles' || k === 'dealerFiles' ? v.map((f) => f.name) : v)));
    delete out.step;
    return out;
  };
  try {
    const resp = await fetch('/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    if (resp.ok && resp.headers.get('content-type')?.includes('json')) {
      const me = await resp.json();
      const id = me.authenticated && (me.email || '').split('@')[0];
      if (id) Object.assign(state, { originator: id, businessContact: id });
    }
  } catch (e) { /* not behind the CDN: keep the sample id */ }

  const toList = () => { window.location.href = '/'; };

  // Copy As New: /create-draft?copy=<id> starts a NEW draft filled in from that communication;
  // the original stays exactly as it was
  const copyId = new URLSearchParams(window.location.search).get('copy');
  let copying = null;
  if (copyId) {
    try {
      copying = await loadDraftForCopy(copyId);
      const mine = { originator: state.originator, businessContact: state.businessContact, draftId: state.draftId };
      Object.assign(state, copying.state, mine, { step: 1, title: `Copy of ${copying.state.title || copying.title}` });
    } catch (e) {
      block.textContent = '';
      const card = el('div', 'cd-card cd-narrow cd-done');
      card.append(el('h2', '', 'This communication cannot be copied'), el('p', '', 'It could not be loaded. Please try again.'));
      const back = el('a', 'cd-btn cd-btn-blue', 'Back to Communications');
      back.href = '/';
      card.append(back);
      block.append(card);
      return;
    }
  }

  // Editing: /create-draft?edit=<id> fills the form with that draft and saves back to it
  const editId = new URLSearchParams(window.location.search).get('edit');
  let editing = null;
  if (editId) {
    try {
      editing = await loadDraftForEdit(editId);
      Object.assign(state, editing.state, { draftId: editId, step: 1 });
    } catch (e) {
      block.textContent = '';
      const card = el('div', 'cd-card cd-narrow cd-done');
      card.append(el('h2', '', 'This draft cannot be edited'), el('p', '', /\b40[39]\b/.test(e.message)
        ? 'Only a draft, or a draft in review, can be edited, and only by the person who made it.'
        : 'It could not be loaded. Please try again.'));
      const back = el('a', 'cd-btn cd-btn-blue', 'Back to Communications');
      back.href = '/';
      card.append(back);
      block.append(card);
      return;
    }
  }

  // Analytics: this journey is not a <form> element, so its start, submit and failure are reported
  // here. They use the report suite's Form Start / Form Submit events with the form name, and a
  // draft that is started but never submitted is the abandonment the suite already measures.
  const formName = (editId && 'edit-draft') || (copyId && 'copy-draft') || 'create-draft';
  const formDetail = () => ({ form: { name: formName, id: state.draftId } });
  let formStarted = false;
  const reportStart = () => {
    if (formStarted) return;
    formStarted = true;
    trackEvent('form-start', block, formDetail());
  };
  block.addEventListener('input', reportStart, true);
  block.addEventListener('change', reportStart, true);

  function render() {
    block.dataset.analyticsStep = String(Math.min(state.step, 7)); // rides along on every event from this block
    block.textContent = '';
    const preview = state.step > STEPS;
    if (copying && !preview) {
      const banner = el('p', 'cd-edit-banner', `Copying \u201C${copying.title}\u201D \u2014 saving creates a new draft; the original stays as it is.`);
      if (copying.source === 'metadata') {
        banner.append(el('span', '', ' This record has no saved message text, so please enter it again.'));
      }
      block.append(banner);
    }
    if (editing && !preview) {
      const banner = el('p', 'cd-edit-banner', `Editing \u201C${state.title || editId}\u201D`);
      if (editing.source === 'metadata') {
        banner.append(el('span', '', ' \u2014 this draft was created before editing was available, so please re-enter the message text.'));
      }
      block.append(banner);
    }
    if (!preview) block.append(stepper(state.step));
    const body = el('div', 'cd-body');
    const clearError = (e) => {
      const f = e.target.closest('.cd-field');
      if (!f) return;
      f.classList.remove('cd-invalid');
      const err = f.querySelector('.cd-error');
      if (err) err.textContent = '';
    };
    body.addEventListener('input', clearError);
    body.addEventListener('change', clearError);
    const nav = el('div', 'cd-nav');
    const btn = (label, cls, fn) => {
      const b = el('button', `cd-btn ${cls}`, label);
      b.type = 'button';
      b.addEventListener('click', fn);
      nav.append(b);
    };
    const go = (n) => {
      // moving forward is a good moment to save progress (a sheet write, never an AEM call)
      if (!editing && n > state.step && n <= 5) saveDraftStep(state.draftId, snapshot());
      state.step = n; render(); window.scrollTo({ top: 0 });
    };

    if (state.step === 1) {
      body.append(step1(state));
      btn('Cancel', 'cd-btn-text', toList);
      btn('Next', 'cd-btn-blue', () => validate(body) && go(2));
    } else if (state.step === 2) {
      body.append(step2(state, () => render()));
      btn('Previous', 'cd-btn-text', () => go(1));
      btn('Next', 'cd-btn-blue', () => validate(body) && go(3));
    } else if (state.step === 3) {
      body.append(step3(state));
      btn('Previous', 'cd-btn-text', () => go(2));
      btn('Next', 'cd-btn-blue', () => validate(body) && go(4));
    } else if (state.step === 4) {
      body.append(step4(state));
      btn('Previous', 'cd-btn-text', () => go(3));
      btn('Preview Field Communication', 'cd-btn-outline', () => validate(body) && go(5));
    } else if (state.step === 5) {
      body.append(previewPane(state, 'field'));
      btn('Previous', 'cd-btn-navy', () => go(4));
      if (isDealer(state)) btn('Preview Dealer Communication', 'cd-btn-outline', () => go(6));
      else btn('Submit', 'cd-btn-blue', () => go(7));
    } else if (state.step === 6) {
      body.append(previewPane(state, 'dealer'));
      btn('Previous', 'cd-btn-navy', () => go(5));
      btn('Submit', 'cd-btn-blue', () => go(7));
    } else {
      // submit
      const done = el('div', 'cd-card cd-narrow cd-done');
      done.append(el('h2', '', 'Submitting…'));
      body.append(done);
      const payload = snapshot();
      (editing ? updateDraft(editId, payload) : createDraft(payload)).then(() => {
        trackEvent('form-submit', block, formDetail());
        done.textContent = '';
        done.append(el('h2', '', editing ? 'Changes saved' : 'Draft created'), el('p', '', editing ? `\u201C${state.title}\u201D was updated.` : `“${state.title}” was saved as a draft.`));
        const home = el('a', 'cd-btn cd-btn-blue', 'Back to Communications');
        home.href = '/';
        done.append(home);
      }).catch(() => {
        trackEvent('form-error', block, formDetail());
        done.textContent = '';
        done.append(el('h2', '', 'Draft not saved'), el('p', '', 'The draft could not be saved. Your entries are kept; try again.'));
        const retry = el('button', 'cd-btn cd-btn-blue', 'Back to review');
        retry.type = 'button';
        retry.addEventListener('click', () => go(5));
        done.append(retry);
      });
    }
    block.append(body, nav);
  }
  render();
}
