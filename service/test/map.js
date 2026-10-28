const assert = require('assert');
const { buildMap } = require('../lib/fmc/dita');
const { handle, ROOT } = require('../lib/fmc/communications');
const { addMap } = require('../lib/fmc/admin');
const { setupGuides, GUIDES_FOLDER } = require('../lib/fmc/guides');

function fakeAem({ failMap = false } = {}) {
  const files = new Map();
  const meta = new Map();
  return {
    files, meta,
    async ensureFolder() {},
    async uploadText(folder, name, text, mime) {
      if (failMap && name.endsWith('.ditamap')) throw new Error('upload down');
      files.set(`${folder}/${name}`, { text, mime });
      meta.set(`${folder}/${name}`, {});
    },
    async setMetadata(p, props) { meta.set(p, { ...(meta.get(p) || {}), ...props }); },
    async getMetadata(p) { return meta.get(p) || null; },
  };
}

const draft = (over = {}) => ({
  title: 'Sales Op & <support>', division: 'FCSD', channel: 'Collision', reviewer: 'mshanm26', alternate: 'ndolloff',
  concurring: 'vck', originator: 'x', businessContact: 'sgorle1', fieldPublish: '2026-10-22T09:00',
  dealerComm: 'Yes', fieldGroup: 'All Ford Field Personnel', fieldLead: ['General Manager'], dealerGroup: 'All Ford & Lincoln Dealers',
  dealerRoles: ['Dealer Principals'], primaryDept: 'Service', fieldOnly: '<p>Field only</p>',
  action: '<p>Do this</p>', summary: '<p>Short summary</p>', questions: '<ul><li>One</li></ul>', ...over,
});

(async () => {
  // the map text: well formed, the topic by relative name, the title escaped
  const xml = buildMap('DRAFT-20261025050852-295l', 'FCD Notification Demo');
  assert.match(xml, /<map id="DRAFT-20261025050852-295l">/);
  assert.match(xml, /<title>FCD Notification Demo<\/title>/);
  assert.match(xml, /<topicref href="DRAFT-20261025050852-295l\.dita"\/>/);
  assert.match(xml, /<!DOCTYPE map PUBLIC "-\/\/OASIS\/\/DTD DITA Map\/\/EN" "map\.dtd">/);
  assert.match(buildMap('X', 'A & <b>'), /<title>A &amp; &lt;b&gt;<\/title>/);

  // a submission lands the topic, the preview and the map in one folder
  const aem = fakeAem();
  const res = await handle({ method: 'POST', path: '/communications', body: draft(), user: 'sgorle1' }, aem);
  assert.equal(res.status, 201);
  const id = res.body.id;
  const map = aem.files.get(`${ROOT}/${id}/${id}.ditamap`);
  assert.ok(map, 'map uploaded beside the topic');
  assert.equal(map.mime, 'application/dita+xml');
  assert.match(map.text, new RegExp(`<topicref href="${id}\\.dita"/>`));
  assert.match(map.text, /<title>Sales Op &amp; &lt;support&gt;<\/title>/);
  assert.equal(res.body.map, undefined);

  // a failed map upload does not fail the submission: the topic is saved and the miss is reported
  const bad = fakeAem({ failMap: true });
  const res2 = await handle({ method: 'POST', path: '/communications', body: draft(), user: 'sgorle1' }, bad);
  assert.equal(res2.status, 201);
  assert.equal(res2.body.map, 'not created');
  assert.ok(bad.files.has(`${ROOT}/${res2.body.id}/${res2.body.id}.dita`));

  // add-map repairs it, and is a no-op the second time
  const id2 = res2.body.id;
  bad.meta.set(`${ROOT}/${id2}/${id2}.dita`, { 'dc:title': 'Fixed', fmcStatus: 'DRAFT' });
  const ok = fakeAem();
  ok.meta.set(`${ROOT}/${id2}/${id2}.dita`, { 'dc:title': 'Fixed & more' });
  assert.equal((await addMap(ok, { id: id2 })).map, 'created');
  assert.match(ok.files.get(`${ROOT}/${id2}/${id2}.ditamap`).text, /<title>Fixed &amp; more<\/title>/);
  assert.equal((await addMap(ok, { id: id2 })).map, 'already there');
  await assert.rejects(addMap(ok, { id: '../x' }), /invalid id/);
  await assert.rejects(addMap(ok, { id: 'NOPE-1' }), /no such communication/);

  // reset-map puts the generated map back as a new version (the old one stays in history)
  const { resetMap } = require('../lib/fmc/admin');
  const versions = [];
  const aemR = { async getMetadata(p) { return p.endsWith('.dita') ? { 'dc:title': 'Fixed & more' } : null; }, async uploadText(f, n, text, mime, opts) { versions.push([n, text, opts]); } };
  const rr = await resetMap(aemR, { id: id2 });
  assert.equal(rr.map, 'reset');
  assert.equal(versions[0][2].newVersion, true, 'uploaded as a new version, not over the old one');
  assert.match(versions[0][1], new RegExp(`<topicref href="${id2}\\.dita"/>`));
  assert.match(versions[0][1], /<title>Fixed &amp; more<\/title>/);
  await assert.rejects(resetMap(aemR, { id: '../x' }), /invalid id/);

  // the DITAVAL filters are uploaded once
  const g = fakeAem();
  assert.deepEqual(await setupGuides(g), { 'dealer.ditaval': 'uploaded', 'field.ditaval': 'uploaded' });
  assert.match(g.files.get(`${GUIDES_FOLDER}/dealer.ditaval`).text, /att="audience" val="field"\s+action="exclude"/);
  assert.match(g.files.get(`${GUIDES_FOLDER}/field.ditaval`).text, /att="audience" val="field"\s+action="include"/);
  assert.deepEqual(await setupGuides(g), { 'dealer.ditaval': 'already there', 'field.ditaval': 'already there' });
  console.log('fmc-map: ok');
})().catch((e) => { console.error(e); process.exit(1); });
