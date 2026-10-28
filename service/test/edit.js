const assert = require('assert');
const { loadForEdit, loadForCopy, updateCommunication } = require('../lib/fmc/edit');
const { ROOT, ownerOf } = require('../lib/fmc/communications');

const ID = 'DRAFT-20261025174557-2xhy';
const topic = `${ROOT}/${ID}/${ID}.dita`;
const payload = (over = {}) => ({
  title: 'Edited title', division: 'FCSD', channel: 'Service', reviewer: 'mshanm26', originator: 'x', fieldPublish: '2026-11-02T09:00',
  dealerComm: 'Yes', dealerGroup: 'All Ford & Lincoln Dealers', fieldOnly: '<p>f</p>', action: '<p>a</p>', summary: '<p>s</p>', questions: '<p>q</p>', fieldDue: '', ...over,
});

function setup({ status = 'DRAFT', saved = null, meta = {} } = {}) {
  const m = {
    'dc:title': 'Old title', fmcTitle: 'Old title', fmcStatus: status, fmcAuthor: 'sgorle1', fmcCreated: '2026-10-20T10:00:00', fmcReviewer: 'old', fmcDivision: 'FCSD', fmcFieldLead: 'General Manager; Regional Manager', fmcDealerComm: 'Yes', fmcFieldDue: '2026-10-30', ...meta,
  };
  const log = { uploads: [], meta: [], draft: null, rows: [] };
  const aem = {
    async getMetadata(p) { return p === topic ? m : null; },
    async uploadText(folder, name, text, mime, opts) { log.uploads.push([name, opts && opts.newVersion]); },
    async setMetadata(p, props, opts) { log.meta.push([props, opts]); Object.assign(m, props); },
  };
  const sheets = {
    async getDraft() { return saved; },
    async putDraft(id, doc) { log.draft = doc; },
    async applyChanges(c) { log.rows.push(c); return {}; },
  };
  return { aem, sheets, log, m };
}
const code = async (p) => { try { await p; return null; } catch (e) { return e.status || `other:${e.message}`; } };

(async () => {
  const mine = { owner: ownerOf('', '1.2.3.4'), state: { title: 'Saved title', action: '<p>kept body</p>' } };

  // load: the saved form comes back, and carries the draft id
  let t = setup({ saved: mine });
  let r = await loadForEdit(t.aem, t.sheets, ID, '', '1.2.3.4');
  assert.equal(r.source, 'saved');
  assert.equal(r.state.action, '<p>kept body</p>');
  assert.equal(r.state.draftId, ID);

  // who may: the owner, or a signed-in employee; not someone else, not a guest, not anonymous without a form
  assert.equal(await code(loadForEdit(t.aem, t.sheets, ID, '', '9.9.9.9')), 403);
  assert.equal(await code(loadForEdit(t.aem, t.sheets, ID, 'guest', '1.2.3.4')), 403);
  assert.equal((await loadForEdit(t.aem, t.sheets, ID, 'ynaka', '9.9.9.9')).source, 'saved');
  t = setup();
  assert.equal(await code(loadForEdit(t.aem, t.sheets, ID, '', '1.2.3.4')), 403);

  // an older draft with no saved form: fields from the metadata, no body
  r = await loadForEdit(t.aem, t.sheets, ID, 'ynaka', '');
  assert.equal(r.source, 'metadata');
  assert.deepEqual([r.state.title, r.state.reviewer, r.state.fieldLead], ['Old title', 'old', ['General Manager', 'Regional Manager']]);
  assert.equal(r.state.action, undefined);

  // status and id guards
  for (const status of ['FINAL APPROVAL PENDING', 'GENERATING PDF', 'PDF ERROR', 'APPROVED', 'PUBLISHED']) {
    t = setup({ status });
    assert.equal(await code(loadForEdit(t.aem, t.sheets, ID, 'ynaka', '')), 409, status);
  }
  assert.equal((await loadForEdit(setup({ status: 'REVIEWER PENDING' }).aem, setup().sheets, ID, 'ynaka', '')).status, 'REVIEWER PENDING');
  assert.equal(await code(loadForEdit(t.aem, t.sheets, 'EFC260061', 'ynaka', '')), 404);
  assert.equal(await code(loadForEdit(t.aem, t.sheets, 'DRAFT-20261025174557-zzzz', 'ynaka', '')), 404);

  // update: three new versions, status/created/author untouched, emptied field cleared, owner kept
  t = setup({ status: 'REVIEWER PENDING', saved: mine });
  r = await updateCommunication(t.aem, t.sheets, ID, payload(), '', '1.2.3.4', new Date('2026-10-26T12:00:00Z'));
  assert.deepEqual(r, { id: ID, status: 'REVIEWER PENDING', updated: true });
  assert.deepEqual(t.log.uploads.map((u) => u[0]).sort(), [`${ID}.dita`, `${ID}.ditamap`, `${ID}.html`]);
  assert.ok(t.log.uploads.every((u) => u[1] === true), 'uploaded as new versions');
  const [props, opts] = t.log.meta[0];
  assert.equal(props.fmcTitle, 'Edited title');
  assert.equal(props.fmcModified, '2026-10-26T12:00:00');
  assert.equal(props.fmcFieldDue, '');
  assert.equal(opts.clearEmpty, true);
  for (const k of ['fmcStatus', 'fmcCreated', 'fmcAuthor', 'fmcFileName']) assert.ok(!(k in props), `${k} is left alone`);
  assert.equal(t.m.fmcStatus, 'REVIEWER PENDING');
  assert.equal(t.log.draft.owner, mine.owner);
  assert.equal(t.log.draft.state.title, 'Edited title');

  // a bad form changes nothing; a stranger cannot save
  t = setup({ saved: mine });
  assert.equal(await code(updateCommunication(t.aem, t.sheets, ID, payload({ title: '' }), '', '1.2.3.4')), 422);
  assert.equal(await code(updateCommunication(t.aem, t.sheets, ID, payload(), '', '9.9.9.9')), 403);
  assert.equal(t.log.uploads.length + t.log.meta.length, 0);
  // copy: any communication, any status, by anyone; the original is never written
  for (const status of ['PUBLISHED', 'ARCHIVED', 'GENERATING PDF', 'DRAFT']) {
    t = setup({ status, saved: mine });
    const c = await loadForCopy(t.aem, t.sheets, ID);
    assert.equal(c.source, 'saved');
    assert.equal(c.state.action, '<p>kept body</p>');
    assert.ok(!('draftId' in c.state), 'the copy gets its own id when it is saved');
    assert.equal(t.log.uploads.length + t.log.meta.length + (t.log.draft ? 1 : 0), 0, 'nothing is written');
  }
  t = setup({ status: 'ARCHIVED' });
  const older = await loadForCopy(t.aem, t.sheets, ID);
  assert.deepEqual([older.source, older.state.title, older.title], ['metadata', 'Old title', 'Old title']);
  assert.equal(await code(loadForCopy(t.aem, t.sheets, 'EFC260061')), 404);
  assert.equal(await code(loadForCopy(t.aem, t.sheets, 'DRAFT-20261025174557-zzzz')), 404);
  // older records get the details column added; their message text is untouched; once only
  const { addSidebar } = require('../lib/fmc/admin');
  const body = '<topic id="x"><title>T</title><body><section id="summary" audience="dealer"><title>Summary</title><p>Keep me.</p></section></body></topic>';
  const writes = [];
  const aemS = {
    async getMetadata() { return { 'dc:title': 'T', fmcDealerComm: 'Yes', fmcFieldPublish: '2026-10-22', fmcFieldGroup: 'All Field', fmcFieldLead: 'GM; RM', fmcDealerGroup: 'All Dealers', fmcPrimaryDept: 'Service' }; },
    async getText() { return writes.length ? writes[0][1] : body; },
    async uploadText(f, n, text, m, o) { writes.push([n, text, o && o.newVersion]); },
  };
  assert.equal((await addSidebar(aemS, { id: ID })).sidebar, 'added');
  assert.equal(writes[0][2], true, 'as a new version');
  assert.ok(writes[0][1].includes('<p>Keep me.</p>'), 'the message text is kept');
  assert.ok(/<body><section id="fmc-field-details"/.test(writes[0][1]), 'the details come first');
  assert.ok(writes[0][1].includes('Field Lead</p><p outputclass="fmc-value">GM, RM'), 'values come from the record');
  assert.ok(writes[0][1].includes('id="fmc-dealer-details"'));
  assert.equal((await addSidebar(aemS, { id: ID })).sidebar, 'already there');
  assert.equal(writes.length, 1, 'no second write');
  console.log('fmc-edit: ok');
})().catch((e) => { console.error(e); process.exit(1); });
