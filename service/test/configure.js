const assert = require('node:assert/strict');
const { configure } = require('../actions/configure');

const memStore = () => {
  const m = new Map();
  return { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, m };
};

(async () => {
  const s = memStore();
  await assert.rejects(() => configure({}, s), /aemHost/);
  await assert.rejects(() => configure({ aemHost: 'https://author.example.com' }, s), /credential/);
  await assert.rejects(() => configure({ aemHost: 'http://author.example.com', aemToken: 't' }, s), /https/);
  await assert.rejects(() => configure({ aemHost: 'https://author.example.com/x', aemToken: 't' }, s), /https origin/);

  const r = await configure({ aemHost: 'https://author.example.com/', jwt: { id: 'x', privateKey: 'k', technicalAccount: { clientId: 'c' } } }, s);
  assert.deepEqual(r, { ok: true, host: 'https://author.example.com', has: { token: false, s2s: false, jwt: true } });
  assert.ok(!JSON.stringify(r).includes('privateKey'), 'the answer never carries credentials');

  // a later call keeps what it does not replace
  const r2 = await configure({ clientId: 'id', clientSecret: 'secret' }, s);
  assert.deepEqual(r2.has, { token: false, s2s: true, jwt: true });
  assert.equal(r2.host, 'https://author.example.com');
  assert.equal(s.m.get('config:aem').s2s.scope, 'openid,AdobeID,aem.folders,aem.assets.author');
  console.log('configure: ok');
})().catch((e) => { console.error(e); process.exit(1); });
