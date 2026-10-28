const assert = require('assert');
const { seedBatch, SEED } = require('../lib/fmc/seed');
const { ROOT } = require('../lib/fmc/communications');
const { STATUSES } = require('../lib/fmc/admin');

function fakeAem() {
  const files = new Map(); const meta = new Map();
  return {
    files, meta,
    async ensureFolder() {},
    async uploadText(folder, name, text) { files.set(`${folder}/${name}`, text); },
    async setMetadata(p, props) { meta.set(p, { ...(meta.get(p) || {}), ...props }); },
    async getMetadata(p) { return meta.get(p) || null; },
  };
}

(async () => {
  assert.equal(SEED.length, 15);
  assert.ok(SEED.every((r) => STATUSES.includes(r[1])), 'every seeded status is a real status');
  assert.equal(new Set(SEED.map((r) => r[0])).size, SEED.length, 'unique titles');
  const aem = fakeAem();
  const now = new Date('2026-10-25T20:00:00Z');
  const a = await seedBatch(aem, 0, 8, now);
  const b = await seedBatch(aem, 8, 99, now);
  const created = [...a.created, ...b.created];
  assert.equal(created.length, 15);
  assert.equal(new Set(created.map((c) => c.id)).size, 15, 'unique ids');
  assert.deepEqual(new Set(created.map((c) => c.status)), new Set(['DRAFT', 'REVIEWER PENDING', 'FINAL APPROVAL PENDING', 'PUBLISHED', 'ARCHIVED', 'UNPUBLISH']));
  for (const c of created) {
    const m = aem.meta.get(`${ROOT}/${c.id}/${c.id}.dita`);
    assert.equal(m.fmcStatus, c.status);
    assert.equal(m.fmcSeed, 'demo');
    assert.ok(aem.files.has(`${ROOT}/${c.id}/${c.id}.ditamap`) && aem.files.has(`${ROOT}/${c.id}/${c.id}.html`), 'topic, preview and map');
    assert.ok(m.fmcModified >= m.fmcCreated, 'modified is not before created');
  }
  assert.equal((await seedBatch(aem, 15, 20, now)).created.length, 0);
  console.log('fmc-seed: ok');
})().catch((e) => { console.error(e); process.exit(1); });
