const assert = require('assert');
const { deleteCommunication } = require('../lib/fmc/admin');

const ID = 'DRAFT-20261025040409-txxu';
function setup({ folderExists = true, failAem = false } = {}) {
  const log = [];
  const aem = { async deleteFolder(p) { if (failAem) throw new Error('AEM down'); log.push(['aem', p]); return folderExists; } };
  const sheets = {
    async applyChanges(c) { log.push(['rows', JSON.stringify(c)]); return {}; },
    async deleteDraft(id) { log.push(['draft', id]); },
  };
  const da = { async delete(p) { log.push(['da', p]); }, async unpublish(p) { log.push(['unpublish', p]); } };
  return { aem, sheets, da, log };
}
const del = (t, p) => deleteCommunication(t.aem, t.sheets, t.da, p);

(async () => {
  let t = setup();
  const out = await del(t, { id: ID, confirm: 'yes' });
  assert.equal(out.aem, 'deleted');
  assert.deepEqual(t.log.map((l) => l[0]), ['aem', 'rows', 'draft', 'da', 'unpublish'], 'AEM first, then rows, draft and pdf');
  assert.equal(t.log[0][1], `/content/dam/dealer-communications/${ID}`);
  assert.deepEqual(JSON.parse(t.log[1][1]), { active: { remove: [ID] }, archive: { remove: [ID] } });
  assert.equal(t.log[3][1], `pdfs/${ID.toLowerCase()}.pdf`);

  // a folder that is already gone still cleans up the rest
  t = setup({ folderExists: false });
  assert.equal((await del(t, { id: ID, confirm: 'yes' })).aem, 'not found');
  assert.equal(t.log.length, 5);

  // guards: no confirmation, wrong kind of id, nothing configured
  t = setup();
  await assert.rejects(del(t, { id: ID }), /confirm=yes/);
  await assert.rejects(del(t, { id: ID, confirm: 'true' }), /confirm=yes/);
  for (const bad of ['EFC260061', '../x', 'DRAFT-1', `${ID}/..`, '', undefined]) await assert.rejects(del(t, { id: bad, confirm: 'yes' }), /only draft ids/);
  await assert.rejects(deleteCommunication(t.aem, null, t.da, { id: ID, confirm: 'yes' }), /not configured/);
  assert.equal(t.log.length, 0, 'a refused request touches nothing');

  // if AEM fails, the sheets are left alone
  t = setup({ failAem: true });
  await assert.rejects(del(t, { id: ID, confirm: 'yes' }), /AEM down/);
  assert.equal(t.log.length, 0);
  console.log('fmc-delete: ok');
})().catch((e) => { console.error(e); process.exit(1); });
