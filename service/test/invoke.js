const assert = require('assert');
const { invokeAsync } = require('../lib/fmc/invoke');

(async () => {
  const env = { __OW_API_KEY: 'u:p', __OW_API_HOST: 'https://rt.example', __OW_NAMESPACE: 'ns-1' };
  const seen = [];
  const ok = async (url, o) => { seen.push([url, o]); return { status: 202 }; };
  await invokeAsync('dealer-communications/pdf-start', { id: 'X' }, env, ok);
  assert.equal(seen[0][0], 'https://rt.example/api/v1/namespaces/ns-1/actions/dealer-communications/pdf-start?blocking=false');
  assert.equal(seen[0][1].method, 'POST');
  assert.equal(seen[0][1].headers.Authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.deepEqual(JSON.parse(seen[0][1].body), { id: 'X' });

  // no runtime credentials, a bad name, or a refusal: it rejects so the caller can do the work itself
  await assert.rejects(() => invokeAsync('dealer-communications/pdf-start', {}, {}, ok), /no runtime credentials/);
  await assert.rejects(() => invokeAsync('../x', {}, env, ok), /invalid action name/);
  await assert.rejects(() => invokeAsync('a/b', {}, env, async () => ({ status: 401 })), /401/);
  console.log('invoke: ok');
})().catch((e) => { console.error(e); process.exit(1); });
