const assert = require('node:assert/strict');
const { handle, ROOT } = require('../lib/fmc/communications');
const { createSheetStore, NOTIFICATIONS } = require('../lib/fmc/sheets');
const { createDaClient } = require('../lib/fmc/daClient');

/** Fake DA: JSON documents by path, plus a log of publishes and writes. */
function fakeDa() {
  const docs = new Map();
  const log = { puts: [], publishes: [] };
  return {
    docs, log,
    async getJson(p) { return docs.has(p) ? JSON.parse(JSON.stringify(docs.get(p))) : null; },
    async putJson(p, data) { log.puts.push(p); docs.set(p, JSON.parse(JSON.stringify(data))); },
    async publish(p) { log.publishes.push(p); },
  };
}
function fakeAem() {
  const meta = new Map();
  const files = new Map();
  return {
    meta, files,
    async ensureFolder() {},
    async uploadText(folder, name, text) { files.set(`${folder}/${name}`, text); },
    async setMetadata(p, props) { meta.set(p, props); },
    async getMetadata(p) { return meta.get(p) || null; },
    async getText(p) { return files.get(p) || null; },
    async query() { return []; },
  };
}
const ID = 'DRAFT-20261025101500-ab12';
const create = (over = {}) => ({
  title: 'Sheet test', fieldPublish: '2026-10-26T09:00', dealerComm: 'No', reviewer: 'mshanm26', originator: 'sgorle1', draftId: ID, ...over,
});

async function main() {
  // --- sheet store: created / updated / unchanged, publish only on change
  const da = fakeDa();
  const sheets = createSheetStore(da);
  const t0 = new Date('2026-10-25T10:00:00Z');
  assert.equal(await sheets.upsertActive({ id: ID, fileName: ID, title: 'A', status: 'DRAFT', reviewer: 'r1', author: 'a1' }, t0), 'created');
  assert.equal(await sheets.upsertActive({ id: ID, fileName: ID, title: 'A', status: 'DRAFT', reviewer: 'r1', author: 'a1' }, t0), 'unchanged');
  assert.equal(await sheets.upsertActive({ id: ID, fileName: ID, title: 'B', status: 'DRAFT', reviewer: 'r1', author: 'a1' }, new Date('2026-10-25T10:05:00Z')), 'updated');
  assert.equal(da.log.publishes.length, 2, 'unchanged rows are not republished');
  assert.deepEqual([...new Set(da.log.publishes)], [NOTIFICATIONS]);
  const sheet = da.docs.get(NOTIFICATIONS);
  assert.equal(sheet[':type'], 'sheet');
  assert.equal(sheet.total, 1);
  assert.equal(sheet.data[0].title, 'B');
  assert.equal(sheet.data[0].created, '2026-10-25T10:00:00');
  assert.equal(sheet.data[0].modified, '2026-10-25T10:05:00');
  assert.ok(Object.values(sheet.data[0]).every((v) => typeof v === 'string'), 'sheet cells are strings');
  // other rows are kept and the newest goes first
  await sheets.upsertActive({ id: 'DRAFT-20261025101600-cd34', fileName: 'x', title: 'Second' }, t0);
  assert.deepEqual(da.docs.get(NOTIFICATIONS).data.map((r) => r.title), ['Second', 'B']);

  // --- step save: stores the draft, lists it, enforces ownership
  const da2 = fakeDa();
  const s2 = createSheetStore(da2);
  const save = (body, user, client) => handle({ method: 'PUT', path: `/drafts/${ID}`, body, user, client }, fakeAem(), s2);
  let r = await save({ title: 'Step one', reviewer: 'r1', originator: 'o1', division: 'FCSD' }, '', '203.0.113.1');
  assert.equal(r.status, 200);
  assert.equal(r.body.sheet, 'created');
  assert.equal(da2.docs.get(`data/drafts/${ID.toLowerCase()}.json`).state.division, 'FCSD');
  assert.ok(![...da2.docs.keys()].some((k) => /DRAFT/.test(k)), 'draft documents are addressed in lower case');
  assert.equal(da2.docs.get(NOTIFICATIONS).data[0].title, 'Step one');
  r = await save({ title: 'Step one', reviewer: 'r1', originator: 'o1', division: 'FCSD', channel: 'Collision' }, '', '203.0.113.1');
  assert.equal(r.body.sheet, 'unchanged', 'a step that does not change the row does not republish');
  assert.equal((await save({ title: 'Hijack' }, '', '198.51.100.9')).status, 403, 'another caller cannot overwrite a draft');
  assert.equal((await save({ title: 'Hijack' }, 'someone', '')).status, 403);
  assert.equal(da2.docs.get(NOTIFICATIONS).data[0].title, 'Step one');

  // --- validation and not-configured behaviour
  const bad = (id, body, sh = s2) => handle({ method: 'PUT', path: `/drafts/${id}`, body, client: 'c' }, fakeAem(), sh);
  assert.equal((await bad('EFC260061', {})).status, 400, 'only well-formed draft ids');
  assert.notEqual((await bad('../x', {})).status, 200, 'a traversal path never reaches the draft route');
  assert.equal((await bad('..', {})).status, 400);
  assert.equal((await bad(ID, [1])).status, 400);
  assert.equal((await bad(ID, { blob: 'x'.repeat(300000) })).status, 413);
  assert.equal((await bad(ID, {}, null)).status, 503, 'no DA credential -> 503, not a crash');
  assert.equal((await handle({ method: 'GET', path: '/drafts/x' }, fakeAem(), s2)).status, 405);
  assert.equal((await handle({ method: 'POST', path: '/drafts/x', body: {} }, fakeAem(), s2)).status, 405);

  // --- create with a draft id: unused, owned, listed with its AEM path
  const da3 = fakeDa();
  const s3 = createSheetStore(da3);
  const aem = fakeAem();
  await handle({ method: 'PUT', path: `/drafts/${ID}`, body: { title: 'Sheet test' }, client: 'owner-ip' }, aem, s3);
  assert.equal((await handle({ method: 'POST', path: '/communications', body: create(), client: 'other-ip' }, aem, s3)).status, 403, 'someone else cannot submit it');
  const ok = await handle({ method: 'POST', path: '/communications', body: create(), client: 'owner-ip' }, aem, s3);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.id, ID, 'the AEM asset takes the draft id');
  assert.ok(aem.files.has(`${ROOT}/${ID}/${ID}.dita`));
  assert.equal(da3.docs.get(NOTIFICATIONS).data[0].aemPath, `${ROOT}/${ID}/${ID}.dita`);
  assert.equal((await handle({ method: 'POST', path: '/communications', body: create(), client: 'owner-ip' }, aem, s3)).status, 409, 'cannot submit the same draft twice');
  assert.equal((await handle({ method: 'POST', path: '/communications', body: create({ draftId: 'EFC260061' }), client: 'x' }, aem, s3)).status, 400);
  assert.equal((await handle({ method: 'POST', path: '/communications', body: create({ draftId: '' }), client: 'x' }, fakeAem(), s3)).status, 201, 'no draft id: server picks one');

  // a sheet failure after the asset exists must not fail the request
  const broken = { getDraft: async () => null, putDraft: async () => {}, upsertActive: async () => { throw new Error('DA down'); } };
  const survived = await handle({ method: 'POST', path: '/communications', body: create({ draftId: 'DRAFT-20261025101700-zz99' }), client: 'x' }, fakeAem(), broken);
  assert.equal(survived.status, 201);
  assert.equal(survived.body.sheet, 'not updated');

  // --- DA client: request shapes, token caching, path safety
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    if (String(url).includes('ims/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    return { ok: true, status: 200, json: async () => ({ a: 1 }) };
  };
  const client = createDaClient({ clientId: 'id', clientSecret: 'secret', scopes: 'a, b', org: 'ynaka-adobe', repo: 'dealer-communications', fetchImpl });
  assert.deepEqual(await client.getJson('data/notifications.json'), { a: 1 });
  await client.putJson('data/drafts/x.json', { k: 'v' });
  await client.publish('data/notifications.json');
  const urls = calls.map((c) => `${c.method} ${c.url}`);
  assert.ok(urls.includes('GET https://admin.da.live/source/ynaka-adobe/dealer-communications/data/notifications.json'));
  assert.ok(urls.includes('PUT https://admin.da.live/source/ynaka-adobe/dealer-communications/data/drafts/x.json'));
  assert.ok(urls.includes('POST https://admin.hlx.page/preview/ynaka-adobe/dealer-communications/main/data/notifications.json'));
  assert.ok(urls.includes('POST https://admin.hlx.page/live/ynaka-adobe/dealer-communications/main/data/notifications.json'));
  assert.equal(calls.filter((c) => c.url.includes('ims/token')).length, 1, 'the token is cached across calls');
  assert.equal(calls[0].body.get('scope'), 'a,b');
  assert.equal(calls.find((c) => c.method === 'PUT').headers.Authorization, 'Bearer tok');
  await assert.rejects(() => client.getJson('../etc/passwd'), /invalid path/);
  await assert.rejects(() => client.putJson('data//x.json', {}), /invalid path/);
  assert.throws(() => createDaClient({ clientId: 'i', clientSecret: 's', org: 'a/b', repo: 'r', fetchImpl }), /invalid DA org/);

  // a static bearer token is used as given when the client-credential settings are incomplete
  const calls3 = [];
  const f3 = async (url, init = {}) => { calls3.push({ url: String(url), headers: init.headers || {} }); return { ok: true, status: 200, json: async () => ({ ok: 1 }) }; };
  const viaToken = createDaClient({ org: 'ynaka-adobe', repo: 'dealer-communications', staticToken: 'static-tok', fetchImpl: f3 });
  await viaToken.getJson('data/notifications.json');
  assert.equal(calls3[0].headers.Authorization, 'Bearer static-tok');
  assert.ok(!calls3.some((c) => c.url.includes('ims')), 'no IMS exchange for a static token');
  const none = createDaClient({ org: 'ynaka-adobe', repo: 'dealer-communications', fetchImpl: f3 });
  await assert.rejects(() => none.getJson('data/notifications.json'), /no DA credential configured/);

  // a site publish key is used for publishing instead of the IMS token, and no token is minted for it
  const calls2 = [];
  const f2 = async (url, init = {}) => {
    calls2.push({ url: String(url), headers: init.headers || {} });
    if (String(url).includes('ims/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'da-tok', expires_in: 3600 }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const keyed = createDaClient({ clientId: 'id', clientSecret: 'secret', scopes: 'a', org: 'ynaka-adobe', repo: 'dealer-communications', publishKey: 'site-key', fetchImpl: f2 });
  await keyed.publish('data/notifications.json');
  const posts = calls2.filter((c) => c.url.includes('admin.hlx.page'));
  assert.deepEqual(posts.map((c) => c.url.split('/')[3]), ['preview', 'live']);
  posts.forEach((c) => {
    assert.equal(c.headers['X-Auth-Token'], 'site-key', 'the site key authorizes the publish');
    assert.ok(!c.headers.Authorization, 'the key is sent on its own');
    assert.equal(c.headers['x-content-source-authorization'], 'Bearer da-tok', 'the DA token is handed to the content-source read');
  });
  // without a site key the DA token authorizes both
  calls2.length = 0;
  await createDaClient({ clientId: 'id', clientSecret: 'secret', scopes: 'a', org: 'ynaka-adobe', repo: 'dealer-communications', fetchImpl: f2 }).publish('data/notifications.json');
  calls2.filter((c) => c.url.includes('admin.hlx.page')).forEach((c) => {
    assert.equal(c.headers.Authorization, 'Bearer da-tok');
    assert.equal(c.headers['x-content-source-authorization'], 'Bearer da-tok');
  });

  // the PDF template shown on the lists counts as a change, so rows written before it existed catch up
  {
    const store = createSheetStore(fakeDa());
    const row = { id: ID, fileName: ID, title: 'T', status: 'DRAFT', reviewer: 'r', author: 'a' };
    assert.equal(await store.upsertActive(row, new Date('2026-10-25T10:00:00Z')), 'created');
    assert.equal(await store.upsertActive({ ...row, pdfTemplate: 'Adobe' }, new Date('2026-10-25T10:01:00Z')), 'updated');
    assert.equal(await store.upsertActive({ ...row, pdfTemplate: 'Adobe' }, new Date('2026-10-25T10:02:00Z')), 'unchanged');
  }

  console.log('fmc-sheets: ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
