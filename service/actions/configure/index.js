/*
 * configure — stores the AEM Author host and credential the other actions use (app state key `config:aem`).
 * Not a web action: it can only be invoked with the workspace's own runtime credentials, for example
 *
 *   aio rt action invoke dealer-communications/configure -b -r -P aem-config.json
 *
 * where aem-config.json (kept out of git) holds:
 *   { "aemHost": "https://author-p154856-e1944736.adobeaemcloud.com",
 *     "jwt": { ...the `integration` object of an AEM service credential... } }
 * or, instead of jwt, { "clientId": "...", "clientSecret": "...", "scope": "..." } for an OAuth server-to-server
 * credential. A short-lived "aemToken" is accepted as a fallback. Fields left out keep their stored value.
 * The answer only says which kinds of credential are now stored, never their values.
 */
const { getStore } = require('../../lib/store');

const KEY = 'config:aem';

/** Merges the parameters into the stored AEM config. Exported for tests. */
async function configure(params, store) {
  const host = typeof params.aemHost === 'string' ? params.aemHost.trim().replace(/\/+$/, '') : '';
  const prev = (await store.get(KEY)) || {};
  if (!host && !prev.host) throw new Error('provide aemHost (https://author-...adobeaemcloud.com)');
  if (host && !/^https:\/\/[a-z0-9.-]+$/i.test(host)) throw new Error('aemHost must be an https origin with no path');

  const hasS2s = params.clientId && params.clientSecret;
  const cfg = {
    host: host || prev.host,
    path: params.aemPath || prev.path || '/content/dam',
    token: params.aemToken || prev.token,
    s2s: hasS2s
      ? {
        clientId: params.clientId,
        clientSecret: params.clientSecret,
        scope: params.scope || 'openid,AdobeID,aem.folders,aem.assets.author',
        imsHost: params.imsHost || 'https://ims-na1.adobelogin.com',
      }
      : prev.s2s,
    jwt: params.jwt || prev.jwt,
  };
  if (!cfg.token && !cfg.s2s && !cfg.jwt) throw new Error('provide a credential: jwt, clientId and clientSecret, or aemToken');
  await store.put(KEY, cfg);
  return {
    ok: true,
    host: cfg.host,
    has: { token: !!cfg.token, s2s: !!(cfg.s2s && cfg.s2s.clientId), jwt: !!cfg.jwt },
  };
}

async function main(params) {
  try {
    return { statusCode: 200, body: await configure(params, await getStore()) };
  } catch (err) {
    return { statusCode: 400, body: { error: err.message } };
  }
}

module.exports = { main, configure };
