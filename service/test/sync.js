const assert = require('node:assert/strict');
const {
  topicIdFromPath, eventFor, worthSyncing, handleEvent, syncOne, reconcile, rowFromMetadata, topicPath,
} = require('../lib/fmc/sync');
const { createSheetStore, NOTIFICATIONS, ARCHIVE } = require('../lib/fmc/sheets');
const { createLock } = require('../lib/fmc/lock');
const { ROOT } = require('../lib/fmc/communications');

const sheetOf = (rows) => ({ total: rows.length, limit: rows.length, offset: 0, data: rows, ':type': 'sheet' });
const row = (o) => ({
  id: '', fileName: '', title: '', status: 'DRAFT', reviewer: '-', author: '-', created: '2026-10-01T00:00:00', modified: '2026-10-01T00:00:00', locked: 'false', aemPath: '', pdf: '', note: '', pdfTemplate: 'Dealer Communications', ...o,
});

function fakeDa(initial = {}) {
  const docs = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const log = { puts: [], publishes: [] };
  return {
    docs, log,
    async getJson(p) { return docs.has(p) ? JSON.parse(JSON.stringify(docs.get(p))) : null; },
    async putJson(p, d) { log.puts.push(p); docs.set(p, JSON.parse(JSON.stringify(d))); },
    async publish(p) { log.publishes.push(p); },
  };
}

/** AEM with a map of id -> metadata; query() returns them with their topic paths. */
function fakeAem(assets = {}) {
  return {
    assets,
    async getMetadata(p) { const m = /\/([^/]+)\.dita$/.exec(p); return (m && this.assets[m[1]]) || null; },
    async query({ statuses, limit }) {
      return Object.entries(this.assets).filter(([, m]) => statuses.includes(m.fmcStatus)).slice(0, limit)
        .map(([id, m]) => ({ path: topicPath(id), metadata: m }));
    },
  };
}
const meta = (o) => ({
  'dc:title': 'T', fmcStatus: 'DRAFT', fmcReviewer: 'rev', fmcAuthor: 'auth', fmcCreated: '2026-10-25T10:00:00', fmcModified: '2026-10-25T10:00:00', ...o,
});
const ids = (d, path) => d.docs.get(path).data.map((r) => r.id);

async function main() {
  // --- paths and events
  assert.equal(topicIdFromPath(`${ROOT}/DRAFT-1/DRAFT-1.dita`), 'DRAFT-1');
  ['', null, `${ROOT}/DRAFT-1/other.dita`, `${ROOT}/a/b/a.dita`, `${ROOT}/../x/x.dita`, '/content/dam/other/DRAFT-1/DRAFT-1.dita', `${ROOT}/DRAFT-1/DRAFT-1.html`, `${ROOT}/-x/-x.dita`]
    .forEach((p) => assert.equal(topicIdFromPath(p), null, String(p)));

  const ev = (type, path, extra = {}) => ({ type, data: { repositoryMetadata: { 'repo:path': path }, ...extra } });
  const p1 = `${ROOT}/DRAFT-1/DRAFT-1.dita`;
  assert.equal(eventFor(ev('aem.assets.asset.metadata_updated', '/content/dam/toyota/x.jpg')), null, 'other folders are not ours');
  assert.equal(worthSyncing(eventFor(ev('aem.assets.asset.processing_completed', p1))), true);
  assert.equal(worthSyncing(eventFor(ev('aem.assets.asset.metadata_updated', p1))), true, 'unknown changes: act');
  assert.equal(worthSyncing(eventFor(ev('aem.assets.asset.metadata_updated', p1, { assetMetadata: { 'event:updated': { fmcStatus: 'x' } } }))), true);
  assert.equal(worthSyncing(eventFor(ev('aem.assets.asset.metadata_updated', p1, { assetMetadata: { 'event:updated': { fmPostProcessedAt: 'x', fmUuid: 'y' } } }))), false, 'Guides housekeeping is skipped');
  assert.equal(worthSyncing(eventFor(ev('aem.assets.asset.metadata_updated', p1, { assetMetadata: { 'event:created': ['dc:title'] } }))), true);

  // --- row from metadata
  assert.equal(rowFromMetadata('X', meta({ fmcPdfStyle: 'adobe' })).pdfTemplate, 'Adobe');
  assert.equal(rowFromMetadata('X', meta({ fmcPdfStyle: 'dealer' })).pdfTemplate, 'Dealer Communications');
  assert.equal(rowFromMetadata('X', meta({})).pdfTemplate, 'Dealer Communications', 'no style chosen means the default');
  assert.deepEqual(rowFromMetadata('X', meta({ fmcStatus: 'REVIEWER PENDING' })), row({
    id: 'X', fileName: 'X', title: 'T', status: 'REVIEWER PENDING', reviewer: 'rev', author: 'auth', created: '2026-10-25T10:00:00', modified: '2026-10-25T10:00:00', aemPath: topicPath('X'),
  }));

  // --- an event adds the row; a status change keeps it in place; PUBLISHED moves it to the archive
  const da = fakeDa({ [NOTIFICATIONS]: sheetOf([row({ id: 'EFC260083', title: 'Sample' })]), [ARCHIVE]: sheetOf([row({ id: 'EFC260061', status: 'PUBLISHED' })]) });
  const sheets = createSheetStore(da);
  const aem = fakeAem({ 'DRAFT-1': meta({ fmcStatus: 'DRAFT' }) });
  const t0 = new Date('2026-10-25T11:00:00Z');
  let r = await handleEvent(ev('aem.assets.asset.processing_completed', p1), aem, sheets, t0);
  assert.equal(r.action, 'synced');
  assert.deepEqual(ids(da, NOTIFICATIONS), ['DRAFT-1', 'EFC260083']);
  assert.equal(da.log.publishes.length, 1);

  r = await handleEvent(ev('aem.assets.asset.processing_completed', p1), aem, sheets, t0);
  assert.equal(da.log.publishes.length, 1, 'an event that changes nothing does not republish');

  aem.assets['DRAFT-1'].fmcStatus = 'FINAL APPROVAL PENDING';
  await handleEvent(ev('aem.assets.asset.metadata_updated', p1, { assetMetadata: { 'event:updated': { fmcStatus: 'y' } } }), aem, sheets, new Date('2026-10-25T11:05:00Z'));
  const updated = da.docs.get(NOTIFICATIONS).data.find((x) => x.id === 'DRAFT-1');
  assert.equal(updated.status, 'FINAL APPROVAL PENDING');
  assert.equal(updated.modified, '2026-10-25T11:05:00', 'modified moves when the status changes');
  assert.equal(updated.created, '2026-10-25T10:00:00');

  // PUBLISHED stays on the home list: nothing is archived by itself
  aem.assets['DRAFT-1'].fmcStatus = 'PUBLISHED';
  r = await syncOne(aem, sheets, 'DRAFT-1', new Date('2026-10-25T12:00:00Z'));
  assert.equal(r.placement, 'active');
  assert.deepEqual(ids(da, NOTIFICATIONS).sort(), ['DRAFT-1', 'EFC260083']);
  // archiving it on purpose (status ARCHIVED) moves it; PUBLISHED again brings it back
  aem.assets['DRAFT-1'].fmcStatus = 'ARCHIVED';
  r = await syncOne(aem, sheets, 'DRAFT-1', new Date('2026-10-25T12:01:00Z'));
  assert.equal(r.placement, 'archive');
  assert.deepEqual(ids(da, NOTIFICATIONS), ['EFC260083']);
  assert.deepEqual(ids(da, ARCHIVE), ['DRAFT-1', 'EFC260061']);
  aem.assets['DRAFT-1'].fmcStatus = 'PUBLISHED';
  r = await syncOne(aem, sheets, 'DRAFT-1', new Date('2026-10-25T12:02:00Z'));
  assert.equal(r.placement, 'active');
  // APPROVED (older records) belongs to the archive without a flag
  aem.assets['DRAFT-1'].fmcStatus = 'APPROVED';
  r = await syncOne(aem, sheets, 'DRAFT-1', new Date('2026-10-25T12:03:00Z'));
  assert.equal(r.placement, 'archive');
  assert.deepEqual(ids(da, NOTIFICATIONS), ['EFC260083']);

  aem.assets['DRAFT-1'].fmcStatus = 'UNPUBLISH';
  await syncOne(aem, sheets, 'DRAFT-1');
  assert.equal(da.docs.get(ARCHIVE).data[0].status, 'UNPUBLISH');
  assert.equal(da.docs.get(NOTIFICATIONS).data.length, 1, 'unpublished stays in the archive');

  delete aem.assets['DRAFT-1'];
  r = await syncOne(aem, sheets, 'DRAFT-1');
  assert.equal(r.action, 'removed');
  assert.deepEqual(ids(da, ARCHIVE), ['EFC260061']);
  assert.deepEqual(ids(da, NOTIFICATIONS), ['EFC260083'], 'sample rows (no aemPath) are never touched');

  // --- reconcile repairs drift in both directions and leaves non-AEM rows alone
  const da2 = fakeDa({
    [NOTIFICATIONS]: sheetOf([
      row({ id: 'SAMPLE', title: 'sample' }),                                              // no aemPath: stays
      row({ id: 'STEPDRAFT', title: 'saved steps, not submitted' }),                        // no aemPath: stays
      row({ id: 'A', title: 'old title', status: 'DRAFT', aemPath: topicPath('A') }),       // drifted title/status
      row({ id: 'B', title: 'B', status: 'DRAFT', aemPath: topicPath('B') }),               // published in AEM: should move
      row({ id: 'GONE', title: 'deleted in AEM', aemPath: topicPath('GONE') }),             // asset deleted: remove
    ]),
    [ARCHIVE]: sheetOf([row({ id: 'ARC', status: 'PUBLISHED' }), row({ id: 'C', status: 'APPROVED', aemPath: topicPath('C') })]),
  });
  const s2 = createSheetStore(da2);
  const aem2 = fakeAem({
    A: meta({ 'dc:title': 'new title', fmcStatus: 'REVIEWER PENDING' }),
    B: meta({ fmcStatus: 'ARCHIVED' }),
    C: meta({ fmcStatus: 'FINAL APPROVAL PENDING' }),                                        // reopened: back to active
    D: meta({ fmcStatus: 'DRAFT', 'dc:title': 'never listed' }),                             // missing from sheets: add
  });
  let rep = await reconcile(aem2, s2, new Date('2026-10-25T13:00:00Z'));
  assert.deepEqual([rep.checked, rep.upserted, rep.moved, rep.removed], [4, 4, 2, 1]);
  assert.deepEqual(ids(da2, NOTIFICATIONS).sort(), ['A', 'C', 'D', 'SAMPLE', 'STEPDRAFT']);
  assert.deepEqual(ids(da2, ARCHIVE).sort(), ['ARC', 'B']);
  assert.equal(da2.docs.get(NOTIFICATIONS).data.find((x) => x.id === 'A').title, 'new title');
  const publishes = da2.log.publishes.length;
  rep = await reconcile(aem2, s2);
  assert.equal(rep.written, 'nothing to change');
  assert.equal(da2.log.publishes.length, publishes, 'a second reconcile changes and publishes nothing');

  // --- deletion guards
  const mk = (n) => sheetOf(Array.from({ length: n }, (_, i) => row({ id: `K${i}`, aemPath: topicPath(`K${i}`) })));
  const da3 = fakeDa({ [NOTIFICATIONS]: mk(8), [ARCHIVE]: sheetOf([]) });
  rep = await reconcile(fakeAem({}), createSheetStore(da3));
  assert.match(rep.skippedRemovals, /look gone/, 'an empty AEM answer does not wipe the sheets');
  assert.equal(da3.docs.get(NOTIFICATIONS).data.length, 8);
  const da4 = fakeDa({ [NOTIFICATIONS]: mk(2), [ARCHIVE]: sheetOf([]) });
  rep = await reconcile(fakeAem({}), createSheetStore(da4));
  assert.equal(rep.removed, 2, 'a couple of genuine deletions are applied');

  // --- lock: serialises writers and cannot be held forever
  const mem = new Map();
  const st = { get: async (k) => mem.get(k) ?? null, put: async (k, v) => { mem.set(k, v); }, delete: async (k) => { mem.delete(k); } };
  const lock = createLock(st, { ttlMs: 200, waitMs: 1500 });
  const order = [];
  await Promise.all([1, 2, 3].map((n) => lock.withLock('x', async () => { order.push(`in${n}`); await new Promise((r) => setTimeout(r, 40)); order.push(`out${n}`); })));
  for (let i = 0; i < order.length; i += 2) assert.equal(order[i].replace('in', ''), order[i + 1].replace('out', ''), 'critical sections do not interleave');
  assert.equal(mem.size, 0, 'the lock is released');
  mem.set('fmc:lock:stuck', { owner: 'dead', exp: Date.now() + 100000 });
  await assert.rejects(() => createLock(st, { waitMs: 300 }).withLock('stuck', async () => 1), /sheet busy/);
  mem.set('fmc:lock:old', { owner: 'dead', exp: Date.now() - 1 });
  assert.equal(await createLock(st).withLock('old', async () => 'ok'), 'ok', 'an expired claim is taken over');

  // writes through the sheet store use the lock
  const da5 = fakeDa({ [NOTIFICATIONS]: sheetOf([]), [ARCHIVE]: sheetOf([]) });
  const locked5 = createSheetStore(da5, { lock: createLock(st) });
  await Promise.all([locked5.applyChanges({ active: { upsert: [row({ id: 'P1', aemPath: 'x' })] } }), locked5.applyChanges({ active: { upsert: [row({ id: 'P2', aemPath: 'x' })] } })]);
  assert.deepEqual(ids(da5, NOTIFICATIONS).sort(), ['P1', 'P2'], 'concurrent writers both land');

  console.log('fmc-sync: ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
