const assert = require('node:assert/strict');
const { configure } = require('../actions/configure');

const memStore = () => {
  const m = new Map();
  return { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, m };
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
  const scope = s.m.get('config:aem').s2s.scope;
  assert.ok(scope.includes('additional_info.projectedProductContext') && scope.includes('aem.assets.author'), 'default scope carries the product context');
  // a changed credential drops the cached token
  s.m.set('aem:s2sToken', { token: 'old' });
  await configure({ clientId: 'id2', clientSecret: 's2' }, s);
  assert.equal(s.m.has('aem:s2sToken'), false);
  console.log('configure: ok');
})().catch((e) => { console.error(e); process.exit(1); });
