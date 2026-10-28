const assert = require('node:assert/strict');
const {
  run, setStatus, setArchived, AdminError,
} = require('../lib/fmc/admin');
const { createSheetStore, NOTIFICATIONS, ARCHIVE } = require('../lib/fmc/sheets');
const { topicPath } = require('../lib/fmc/sync');

const empty = { total: 0, limit: 0, offset: 0, data: [], ':type': 'sheet' };
function da() {
  const docs = new Map([[NOTIFICATIONS, empty], [ARCHIVE, empty]]);
  const log = { publishes: [] };
  return { docs, log, getJson: async (p) => JSON.parse(JSON.stringify(docs.get(p) || empty)), putJson: async (p, d) => { docs.set(p, d); }, publish: async (p) => { log.publishes.push(p); } };
}
function aemWith(assets) {
  return {
    assets,
    getMetadata: async (p) => assets[/\/([^/]+)\.dita$/.exec(p)[1]] || null,
    setMetadata: async (p, props) => { Object.assign(assets[/\/([^/]+)\.dita$/.exec(p)[1]], props); },
    query: async () => [],
  };
}

(async () => {
  const d = da();
  const sheets = createSheetStore(d);
  const aem = aemWith({ ID1: { 'dc:title': 'T', fmcStatus: 'DRAFT', fmcCreated: '2026-10-25T10:00:00', fmcAuthor: 'a', fmcReviewer: 'r' } });
  const now = new Date('2026-10-25T12:00:00Z');

  let r = await setStatus(aem, sheets, { id: 'ID1', status: 'REVIEWER PENDING' }, now);
  assert.equal(aem.assets.ID1.fmcStatus, 'REVIEWER PENDING');
  assert.equal(aem.assets.ID1.fmcModified, '2026-10-25T12:00:00');
  assert.equal(r.sheet.placement, 'active');
  assert.equal(d.docs.get(NOTIFICATIONS).data[0].status, 'REVIEWER PENDING');

  // PUBLISHED stays on the home list; APPROVED and UNPUBLISH are archive statuses
  r = await setStatus(aem, sheets, { id: 'ID1', status: 'PUBLISHED' }, now);
  assert.equal(r.sheet.placement, 'active');
  assert.equal(d.docs.get(NOTIFICATIONS).data[0].status, 'PUBLISHED');
  // archiving is deliberate: only a published communication, it becomes ARCHIVED, and Restore undoes it
  await setStatus(aem, sheets, { id: 'ID1', status: 'DRAFT', sync: false }, now);
  await assert.rejects(setArchived(aem, sheets, { id: 'ID1', archived: true }, now), /only a published/);
  await setStatus(aem, sheets, { id: 'ID1', status: 'PUBLISHED' }, now);
  await assert.rejects(setArchived(aem, sheets, { id: 'ID1', archived: false }, now), /only an archived/);
  r = await setArchived(aem, sheets, { id: 'ID1', archived: true }, now);
  assert.deepEqual([r.status, r.sheet.placement], ['ARCHIVED', 'archive']);
  assert.equal(d.docs.get(NOTIFICATIONS).data.length, 0);
  assert.equal(d.docs.get(ARCHIVE).data[0].status, 'ARCHIVED');
  r = await setArchived(aem, sheets, { id: 'ID1', archived: false }, now);
  assert.deepEqual([r.status, r.sheet.placement], ['PUBLISHED', 'active']);
  // a failed sheet update does not fail an action whose AEM change is saved
  const broken = { ...sheets, applyChanges: async () => { throw new Error('DA down'); }, readAll: sheets.readAll };
  r = await setStatus(aem, broken, { id: 'ID1', status: 'REVIEWER PENDING' }, now);
  assert.equal(r.status, 'REVIEWER PENDING');
  assert.equal(r.sheet.action, 'pending');
  assert.equal(aem.assets.ID1.fmcStatus, 'REVIEWER PENDING');
  await setStatus(aem, sheets, { id: 'ID1', status: 'PUBLISHED' }, now);
  r = await setStatus(aem, sheets, { id: 'ID1', status: 'APPROVED' }, now);
  assert.equal(r.sheet.placement, 'archive');

  r = await setStatus(aem, sheets, { id: 'ID1', status: 'DRAFT', sync: false }, now);
  assert.equal(r.sheet, undefined, 'sync can be left to the event');
  assert.equal(d.docs.get(ARCHIVE).data.length, 1, 'and then the sheets are not touched');

  for (const bad of [{ id: 'ID1', status: 'LOST' }, { id: '../x', status: 'DRAFT' }, { id: '', status: 'DRAFT' }, { id: 'NOPE', status: 'DRAFT' }]) {
    await assert.rejects(() => setStatus(aem, sheets, bad, now), AdminError, JSON.stringify(bad));
  }
  await assert.rejects(() => run({ op: 'drop-tables' }, aem, sheets), /op must be/);
  await assert.rejects(() => run({ op: 'reconcile' }, aem, null), /not configured/);
  // the fake AEM lists nothing, so the one AEM-backed archive row reads as deleted and is removed
  const rep = await run({ op: 'reconcile' }, aem, sheets);
  assert.equal(rep.removed, 1);
  assert.equal(d.docs.get(ARCHIVE).data.length, 0);
  assert.equal((await run({ op: 'reconcile' }, aem, sheets)).written, 'nothing to change');
  console.log('admin: ok');
})().catch((e) => { console.error(e); process.exit(1); });
