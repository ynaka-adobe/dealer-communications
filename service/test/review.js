const assert = require('assert');
const {
  handleReview, ReviewError, findPdfUrl, trustedCaller,
} = require('../lib/fmc/review');
const { ROOT } = require('../lib/fmc/communications');

const ID = 'DRAFT-20261025174557-2xhy';
const topic = `${ROOT}/${ID}/${ID}.dita`;

// workflow: 'forbidden' = the service account cannot start workflows (approve falls back to an
// existing PDF); 'ok' = the workflow starts
function setup(meta = { 'dc:title': 'My Title', fmcStatus: 'FINAL APPROVAL PENDING' }, workflow = 'forbidden') {
  const calls = { meta: [], put: [], pub: [], changes: [], probes: [], started: [] };
  const aem = {
    async getMetadata(p) { return p === topic ? meta : null; },
    async setMetadata(p, props) { calls.meta.push(props); Object.assign(meta, props); },
    async uploadText() {},
    async readNode() { return { 'guides:assetState': 'SUCCESS' }; },
    async generateOutput(mapPath, output) {
      if (workflow === 'forbidden') { const e = new Error('AEM generate -> HTTP 403'); e.status = 403; throw e; }
      calls.started.push([mapPath, output]);
      return { success: true, generationId: 'gen-1' };
    },
  };
  const da = { async putBinary(p, b) { calls.put.push([p, b.length]); }, async publish(p) { calls.pub.push(p); } };
  const sheets = { async applyChanges(c) { calls.changes.push(c); return {}; } };
  return { aem, da, sheets, calls };
}
const pdf = Buffer.from('%PDF-1.4 x');
const web = (have, calls) => async (u, o = {}) => {
  if (o.method === 'HEAD') { calls.probes.push(String(u)); return { ok: have.some((h) => String(u).endsWith(h)) }; }
  return { ok: true, status: 200, arrayBuffer: async () => pdf };
};
const run = (req, d, extra = {}) => handleReview(req, { ...d, secret: 's3cret', ...extra });
const code = async (p) => { try { await p; return null; } catch (e) { return e instanceof ReviewError ? e.status : `other:${e.message}`; } };

(async () => {
  let t = setup();
  // no code configured: anonymous visitors may act. With a code configured, a wrong or missing one is refused first
  assert.equal(await code(run({ id: ID, action: 'archive' }, t, { secret: '' })), 409, 'allowed through; a draft just cannot be archived');
  assert.equal(await code(run({ id: ID, action: 'reviewer', code: 'nope' }, t)), 403);
  assert.equal(await code(run({ id: ID, action: 'reviewer' }, t)), 403);
  assert.equal(t.calls.meta.length, 0);
  assert.equal((await run({ id: ID, action: 'reviewer', code: 's3cret' }, t)).status, 'REVIEWER PENDING');
  t = setup();

  // who counts as trusted: any session the edge function vouches for (employee or guest code), never anonymous
  assert.deepEqual(['ynaka', 'guest', '', '  ', undefined, null].map(trustedCaller), [true, true, false, false, false, false]);

  // status steps
  let r = await run({ id: ID, action: 'reviewer', code: 's3cret' }, t);
  assert.equal(r.status, 'REVIEWER PENDING');
  assert.equal(t.calls.meta[0].fmcStatus, 'REVIEWER PENDING');
  r = await run({ id: ID, action: 'final', code: 's3cret' }, t);
  assert.equal(r.status, 'FINAL APPROVAL PENDING');
  assert.equal(await code(run({ id: ID, action: 'delete', code: 's3cret' }, t)), 400);
  assert.equal(await code(run({ id: 'NOPE-1', action: 'reviewer', code: 's3cret' }, t)), 404);
  assert.equal(await code(run({ id: '../x', action: 'reviewer', code: 's3cret' }, t)), 409);

  // archive and restore: deliberate, and only for a published communication
  t = setup({ 'dc:title': 'My Title', fmcStatus: 'PUBLISHED' });
  r = await run({ id: ID, action: 'archive', code: 's3cret' }, t);
  assert.equal(r.status, 'ARCHIVED');
  assert.equal(t.calls.meta.at(-1).fmcStatus, 'ARCHIVED');
  assert.equal(t.calls.changes.at(-1).archive.upsert[0].id, ID, 'moved to the archive');
  r = await run({ id: ID, action: 'restore', code: 's3cret' }, t);
  assert.equal(r.status, 'PUBLISHED');
  assert.equal(t.calls.changes.at(-1).active.upsert[0].id, ID, 'and back to the home list');
  assert.equal(await code(run({ id: ID, action: 'restore', code: 's3cret' }, t)), 409, 'only an archived one can be restored');
  t = setup({ 'dc:title': 'My Title', fmcStatus: 'DRAFT' });
  assert.equal(await code(run({ id: ID, action: 'archive', code: 's3cret' }, t)), 409, 'a draft cannot be archived');

  // approve asks Guides to generate the map's PDF and marks the communication as generating
  t = setup(undefined, 'ok');
  r = await run({ id: ID, action: 'approve', code: 's3cret' }, t);
  assert.equal(r.status, 'GENERATING PDF');
  assert.deepEqual(t.calls.started, [[`${ROOT}/${ID}/${ID}.ditamap`, 'pdf']]);
  assert.equal(t.calls.meta.at(-1).fmcPdfJob, 'gen-1');
  assert.equal(t.calls.put.length, 0, 'nothing hosted until the PDF exists');
  // a second click while it runs starts nothing new
  r = await run({ id: ID, action: 'approve', code: 's3cret' }, t);
  assert.equal(r.already, true);
  assert.equal(t.calls.started.length, 1);

  // cannot start workflows and no PDF exists: a clear message that carries the HTTP status
  t = setup();
  assert.equal(await code(run({ id: ID, action: 'approve', code: 's3cret' }, t, { fetchImpl: web([], t.calls) })), 403);

  // approve (workflow not allowed): PDF named after the id is preferred
  t = setup();
  r = await run({ id: ID, action: 'approve', code: 's3cret' }, t, { fetchImpl: web([`${ID}-ditamap.pdf`], t.calls) });
  assert.equal(r.status, 'PUBLISHED');
  assert.equal(r.pdf, `/pdfs/${ID.toLowerCase()}.pdf`);
  assert.equal(t.calls.changes[0].active.upsert[0].pdf, r.pdf);

  // approve: the map named with _Native PDF is found too
  t = setup();
  r = await run({ id: ID, action: 'approve', code: 's3cret' }, t, { fetchImpl: web([`${ID}_Native%20PDF.pdf`], t.calls) });
  assert.equal(r.status, 'PUBLISHED');
  assert.equal(t.calls.probes.length, 1, 'found on the first name tried');

  // approve: falls back to the title-based name
  t = setup();
  r = await run({ id: ID, action: 'approve', code: 's3cret' }, t, { fetchImpl: web(['my-title_Native%20PDF.pdf'], t.calls) });
  assert.equal(r.status, 'PUBLISHED');
  assert.equal(t.calls.probes.length, 3);

  // approve with no PDF yet: a clear 409 and nothing changes
  t = setup();
  const e409 = await code(run({ id: ID, action: 'approve', code: 's3cret' }, t, { fetchImpl: web([], t.calls) }));
  assert.equal(e409, 403);
  assert.equal(t.calls.meta.length + t.calls.put.length + t.calls.changes.length, 0);

  // the probe only goes to the configured AEM publish host
  t = setup();
  assert.equal(await findPdfUrl(t.aem, ID, 'publish-x.adobeaemcloud.com', web([`${ID}-ditamap.pdf`], t.calls)), `https://publish-x.adobeaemcloud.com/content/dam/fmdita-outputs/pdfs/${ID}-ditamap.pdf`);
  console.log('fmc-review: ok');
})().catch((e) => { console.error(e); process.exit(1); });
