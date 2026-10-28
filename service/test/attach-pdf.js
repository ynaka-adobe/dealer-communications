const assert = require('assert');
const { attachPdf } = require('../lib/fmc/admin');

const ID = 'DRAFT-20261025050852-295l';
const pdf = Buffer.from('%PDF-1.4\nbody');
const mk = (meta = { fmcStatus: 'DRAFT', fmcTitle: 'T' }) => {
  const calls = { meta: [], put: [], pub: [], changes: [] };
  const aem = {
    async getMetadata() { return meta; },
    async setMetadata(p, props) { calls.meta.push(props); Object.assign(meta, props); },
  };
  const da = { async putBinary(p, b, t) { calls.put.push([p, b.length, t]); }, async publish(p) { calls.pub.push(p); } };
  const sheets = { async applyChanges(c) { calls.changes.push(c); return {}; } };
  return { aem, da, sheets, calls };
};
const ok = (body = pdf) => async () => ({ ok: true, status: 200, arrayBuffer: async () => body });

(async () => {
  let t = mk();
  const out = await attachPdf(t.aem, t.sheets, t.da, { id: ID, url: 'http://publish-p1-e1.adobeaemcloud.com/a/b.pdf' }, new Date(), ok());
  assert.strictEqual(out.status, 'PUBLISHED');
  assert.strictEqual(out.pdf, `/pdfs/${ID.toLowerCase()}.pdf`);
  assert.deepStrictEqual(t.calls.put[0], [`pdfs/${ID.toLowerCase()}.pdf`, pdf.length, 'application/pdf']);
  assert.deepStrictEqual(t.calls.pub, [`pdfs/${ID.toLowerCase()}.pdf`]);
  assert.strictEqual(t.calls.meta[0].fmcPdf, out.pdf);
  const c = t.calls.changes[0];
  assert.strictEqual(c.active.upsert[0].pdf, out.pdf); // published with its link, and it stays on the home list
  assert.deepStrictEqual(c.archive.remove, [ID]);

  const bad = (url, f = ok(), id = ID) => attachPdf(mk().aem, mk().sheets, mk().da, { id, url }, new Date(), f);
  await assert.rejects(bad('https://evil.example.com/x.pdf'), /adobeaemcloud\.com/);
  await assert.rejects(bad('https://p.adobeaemcloud.com/x.pdf', ok(Buffer.from('<html>'))), /not a PDF/);
  await assert.rejects(bad('https://p.adobeaemcloud.com/x.pdf', async () => ({ ok: false, status: 404 })), /HTTP 404/);
  await assert.rejects(bad('https://p.adobeaemcloud.com/x.pdf', ok(), '../x'), /invalid id/);
  await assert.rejects(attachPdf(mk().aem, mk().sheets, mk().da, { id: ID, url: 'https://p.adobeaemcloud.com/x.pdf', status: 'DRAFT' }, new Date(), ok()), /status must be/);
  console.log('fmc-attach-pdf: ok');
})().catch((e) => { console.error(e); process.exit(1); });
