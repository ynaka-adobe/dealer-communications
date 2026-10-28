const assert = require('node:assert/strict');
const fs = require('node:fs');
const { handle, validateDraft, ROOT } = require('../lib/fmc/communications');
const { buildDocuments, convertRichText, longDate } = require('../lib/fmc/dita');
const { createAemClient } = require('../lib/fmc/aemAuthor');

/** In-memory AEM: records every call so the tests can assert on what would be sent. */
function fakeAem() {
  const folders = new Map();
  const files = new Map();
  const meta = new Map();
  return {
    folders, files, meta,
    async ensureFolder(p, title) { folders.set(p, title); },
    async uploadText(folder, name, text, mime) { files.set(`${folder}/${name}`, { text, mime }); },
    async setMetadata(p, props) { meta.set(p, { ...(meta.get(p) || {}), ...props }); },
    async getMetadata(p) { return meta.get(p) || null; },
    async getText(p) { return files.has(p) ? files.get(p).text : null; },
    async query({ statuses }) {
      return [...meta.entries()].filter(([, m]) => statuses.includes(m.fmcStatus)).map(([p, m]) => ({ path: p, metadata: m }));
    },
  };
}

const draft = (over = {}) => ({
  title: 'TestOct21-FCSD', division: 'FCSD', channel: 'Collision', reviewer: 'mshanm26', alternate: 'ndolloff',
  concurring: 'vck', originator: 'browser-claim', businessContact: 'sgorle1', fieldPublish: '2026-10-22T09:00',
  dealerComm: 'Yes', fieldGroup: 'All Ford Field Personnel', fieldLead: ['General Manager'], dealerGroup: 'All Ford & Lincoln Dealers',
  dealerRoles: ['Dealer Principals'], primaryDept: 'Service', fieldOnly: '<p>Field only</p>',
  action: '<p>Do <b>this</b></p>', summary: '<p>Short summary</p>', questions: '<ul><li>One</li></ul>',
  extraSections: [{ title: 'Background', html: '<p>More</p>' }], ...over,
});

async function main() {
  // --- DITA conversion neutralizes hostile markup
  const hostile = convertRichText('<p>a<script>alert(1)</script><img src=x onerror=alert(2)><a href="javascript:alert(3)">x</a> <a href="https://ford.com/?a=1&b=2">ok</a></p>');
  assert.ok(!/script|onerror|javascript:|<img/i.test(hostile.dita + hostile.html));
  assert.match(hostile.dita, /<xref href="https:\/\/ford\.com\/\?a=1&amp;b=2"/);

  // --- topic structure: audience sections, escaped title, metadata
  const d = validateDraft(draft({ title: 'T & <x>' }), 'sgorle1', new Date('2026-10-22T14:00:00Z'));
  const { dita, preview } = buildDocuments(d);
  assert.match(dita, /<title>T &amp; &lt;x&gt;<\/title>/);
  assert.match(dita, /<section id="field-only-information" audience="field">/);
  assert.match(dita, /<section id="action-requested" audience="dealer">/);
  assert.match(dita, /<othermeta name="fmcStatus" content="DRAFT"\/>/);
  assert.ok(!/<othermeta name="fmcFieldDue"/.test(dita), 'empty metadata is omitted');
  assert.match(preview, /<section data-audience="dealer"><h2>Summary<\/h2>/);

  // the details beside the message: field details for the field audience, dealer details for dealers
  assert.match(dita, /<section id="fmc-field-details" audience="field" outputclass="fmc-sidebar"><title>Field details<\/title><p outputclass="fmc-label">Field Publish Date<\/p><p outputclass="fmc-value">October 22, 2026<\/p>/);
  assert.match(dita, /<p outputclass="fmc-label">Field Lead<\/p><p outputclass="fmc-value">General Manager<\/p>/);
  assert.match(dita, /<section id="fmc-dealer-details" audience="dealer" outputclass="fmc-sidebar">/);
  assert.match(dita, /<p outputclass="fmc-label">Dealer Publish Date<\/p><p outputclass="fmc-value">October 23, 2026<\/p>/);
  assert.ok(dita.indexOf('fmc-field-details') < dita.indexOf('field-only-information'), 'the details come first');
  assert.ok(!/fmc-sidebar/.test(preview), 'the HTML preview is unchanged');
  assert.equal(longDate('2026-10-31T09:00', 1), 'November 1, 2026');
  assert.equal(longDate(''), '');
  const fieldOnly = buildDocuments(validateDraft({ ...draft(), dealerComm: 'No', action: '', summary: '', questions: '', dealerGroup: '' }, 'sgorle1', new Date(), 'X')).dita;
  assert.ok(!/fmc-dealer-details/.test(fieldOnly), 'no dealer details when there is no dealer communication');
  assert.match(buildDocuments(validateDraft({ ...draft(), fieldLead: [], fieldPublish: '2026-10-22' }, 'sgorle1', new Date(), 'X')).dita, /Field Lead<\/p><p outputclass="fmc-value">\u2014<\/p>/, 'an empty value shows a dash');

  // --- validation: server enforces required fields, limits, and the signed-in user wins
  assert.equal(d.author, 'sgorle1');
  assert.throws(() => validateDraft({ ...draft(), title: '' }), /title is required/);
  assert.throws(() => validateDraft({ ...draft(), title: 'x'.repeat(251) }), /250/);
  assert.throws(() => validateDraft({ ...draft(), summary: `<p>${'s'.repeat(601)}</p>` }), /600/);
  assert.throws(() => validateDraft({ ...draft(), questions: '' }), /questions are required/);
  assert.throws(() => validateDraft({ ...draft(), fieldPublish: 'tomorrow' }), /fieldPublish/);
  assert.equal(validateDraft(draft({ dealerComm: 'No', action: '', summary: '', questions: '', dealerGroup: '' })).dealerComm, false);

  // --- routes against the fake AEM
  const aem = fakeAem();
  const created = await handle({ method: 'POST', path: '/communications', body: draft(), user: 'sgorle1' }, aem);
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.match(id, /^DRAFT-\d{14}-[a-z0-9]{4}$/);
  assert.ok(aem.folders.has(ROOT) && aem.folders.has(`${ROOT}/${id}`));
  assert.ok(aem.files.has(`${ROOT}/${id}/${id}.dita`) && aem.files.has(`${ROOT}/${id}/${id}.html`));
  assert.equal(aem.files.get(`${ROOT}/${id}/${id}.dita`).mime, 'application/dita+xml');
  assert.equal(aem.meta.get(`${ROOT}/${id}/${id}.dita`).fmcAuthor, 'sgorle1');

  const active = await handle({ method: 'GET', path: '/communications', query: { type: 'active' } }, aem);
  assert.equal(active.body.length, 1);
  assert.deepEqual([active.body[0].id, active.body[0].status, active.body[0].reviewer, active.body[0].author], [id, 'DRAFT', 'mshanm26', 'sgorle1']);
  assert.equal((await handle({ method: 'GET', path: '/communications', query: { type: 'archive' } }, aem)).body.length, 0);

  const status = await handle({ method: 'GET', path: `/communications/${id}/status` }, aem);
  assert.equal(status.body.status, 'DRAFT');

  // an approved (older) item is listed in the archive and its detail renders
  aem.meta.get(`${ROOT}/${id}/${id}.dita`).fmcStatus = 'APPROVED';
  assert.equal((await handle({ method: 'GET', path: '/communications', query: { type: 'archive' } }, aem)).body.length, 1);
  const detail = await handle({ method: 'GET', path: `/communications/${id}` }, aem);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.title, 'TestOct21-FCSD');
  // title fallbacks when the Assets API omits dc:title
  delete aem.meta.get(`${ROOT}/${id}/${id}.dita`)['dc:title'];
  assert.equal((await handle({ method: 'GET', path: `/communications/${id}` }, aem)).body.title, 'TestOct21-FCSD');
  delete aem.meta.get(`${ROOT}/${id}/${id}.dita`).fmcTitle;
  assert.equal((await handle({ method: 'GET', path: `/communications/${id}` }, aem)).body.title, 'TestOct21-FCSD');
  assert.ok(detail.body.fields.some(([k, v]) => k === 'Field Publish Date' && v === 'October 22, 2026'));
  assert.match(detail.body.body, /<h2>Action requested<\/h2>/);
  assert.ok(!/<h1>/.test(detail.body.body));

  // --- errors and abuse
  assert.equal((await handle({ method: 'GET', path: '/communications/NOPE' }, aem)).status, 404);
  assert.equal((await handle({ method: 'GET', path: '/communications/..%2F..%2Fetc' }, aem)).status, 404);
  assert.equal((await handle({ method: 'POST', path: '/communications', body: {} }, aem)).status, 422);
  assert.equal((await handle({ method: 'POST', path: '/communications', body: [1] }, aem)).status, 400);
  assert.equal((await handle({ method: 'DELETE', path: '/communications' }, aem)).status, 405);
  assert.equal((await handle({ method: 'GET', path: '/other' }, aem)).status, 404);

  // --- real client: requests it would make, with a fake fetch and upload SDK
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body, auth: init.headers && init.headers.Authorization });
    if (String(url).includes('/bin/querybuilder.json')) {
      return { ok: true, status: 200, json: async () => ({ hits: [{ 'jcr:path': `${ROOT}/EFC1/EFC1.dita`, 'jcr:content': { metadata: { fmcStatus: 'DRAFT', 'dc:title': 'T' } } }] }) };
    }
    return { ok: true, status: 201, text: async () => '{}', json: async () => ({}) };
  };
  const uploads = [];
  const sdk = {
    DirectBinaryUpload: class { async uploadFiles(o) { uploads.push(o); return { totalCompleted: 1, errors: [] }; } },
    DirectBinaryUploadOptions: class {
      constructor() { this.o = {}; }
      withUrl(u) { this.o.url = u; return this; }
      withUploadFiles(f) { this.o.files = f; return this; }
      withHttpOptions(h) { this.o.http = h; return this; }
      withConcurrent() { return this; }
    },
  };
  try {
    const client = createAemClient({ host: 'https://author.example.com', token: 'tkn', sdk });
    await client.ensureFolder(`${ROOT}/EFC1`, 'T');
    assert.equal(calls[0].url, 'https://author.example.com/api/assets/dealer-communications/EFC1');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].auth, 'Bearer tkn');
    await client.uploadText(`${ROOT}/EFC1`, 'EFC1.dita', '<topic/>', 'application/dita+xml');
    assert.equal(uploads[0].o.url, 'https://author.example.com/content/dam/dealer-communications/EFC1');
    assert.equal(uploads[0].o.files[0].fileName, 'EFC1.dita');
    assert.ok(!fs.existsSync(uploads[0].o.files[0].filePath), 'temp file is removed');
    await assert.rejects(() => client.uploadText(`${ROOT}/EFC1`, '../x.dita', 'x', 'text/plain'), /invalid asset file name/);
    await assert.rejects(() => client.ensureFolder('/content/dam/../users', 'x'), /specific folder/);
    await client.setMetadata(`${ROOT}/EFC1/EFC1.dita`, { fmcStatus: 'DRAFT', 'dc:title': 'A & B', fmcEmpty: '' });
    const post = calls.at(-1);
    assert.equal(post.url, 'https://author.example.com/content/dam/dealer-communications/EFC1/EFC1.dita/jcr:content/metadata');
    assert.equal(post.method, 'POST');
    const form = new URLSearchParams(String(post.body));
    assert.equal(form.get('fmcStatus'), 'DRAFT');
    assert.equal(form.get('dc:title'), 'A & B');
    assert.ok(!form.has('fmcEmpty'), 'empty values are not written');
    await assert.rejects(() => client.setMetadata('/content/dam/../x.dita', { a: 'b' }), /specific folder/);
    const hits = await client.query({ path: ROOT, statuses: ['DRAFT', 'REVIEWER PENDING'] });
    assert.equal(hits[0].metadata.fmcStatus, 'DRAFT');
    const qUrl = new URL(calls.at(-1).url);
    assert.equal(qUrl.searchParams.get('1_property.1_value'), 'DRAFT');
    assert.equal(qUrl.searchParams.get('1_property.2_value'), 'REVIEWER PENDING');
    assert.throws(() => createAemClient({ host: 'http://insecure.example', token: 't' }), /HTTPS/);
  } finally {
    global.fetch = realFetch;
  }

  console.log('dealer-communications: ok');
}

main().catch((e) => { console.error(e); process.exit(1); });

// --- anonymous creation caps and attribution (appended; runs after the main checks)
(async () => {
  const { allowAnonymousCreate } = require('../lib/fmc/limits');
  const mem = new Map();
  const store = { get: async (k) => mem.get(k) || null, put: async (k, v) => { mem.set(k, v); } };
  const t0 = new Date('2026-10-25T10:10:00Z');

  for (let i = 0; i < 5; i += 1) assert.equal((await allowAnonymousCreate(store, '1.2.3.4', t0)).ok, true);
  const blocked = await allowAnonymousCreate(store, '1.2.3.4', t0);
  assert.deepEqual([blocked.ok, blocked.scope], [false, 'client']);
  assert.ok(blocked.retryAfter > 0 && blocked.retryAfter <= 3600);
  assert.equal((await allowAnonymousCreate(store, '5.6.7.8', t0)).ok, true, 'other callers are unaffected');
  assert.equal((await allowAnonymousCreate(store, '1.2.3.4', new Date('2026-10-25T11:00:01Z'))).ok, true, 'a new hour resets the per-caller cap');

  const day = new Map();
  const s2 = { get: async (k) => day.get(k) || null, put: async (k, v) => { day.set(k, v); } };
  for (let i = 0; i < 3; i += 1) assert.equal((await allowAnonymousCreate(s2, `c${i}`, t0, { perDay: 3 })).ok, true);
  assert.equal((await allowAnonymousCreate(s2, 'c9', t0, { perDay: 3 })).scope, 'day');
  assert.equal((await allowAnonymousCreate(s2, 'c9', new Date('2026-10-26T00:00:01Z'), { perDay: 3 })).ok, true, 'a new day resets the daily cap');

  // attribution: no signed-in user -> flagged anonymous, author from the form; signed-in user wins
  const anon = validateDraft(draft(), '', new Date('2026-10-25T10:00:00Z'));
  assert.equal(anon.metadata.fmcAnonymous, 'Yes');
  assert.equal(anon.author, 'browser-claim');
  const signed = validateDraft(draft(), 'sgorle1', new Date('2026-10-25T10:00:00Z'));
  assert.equal(signed.metadata.fmcAnonymous, '');
  assert.equal(signed.author, 'sgorle1');
  console.log('dealer-communications limits: ok');
})().catch((e) => { console.error(e); process.exit(1); });
