/*
 * Builds the AEM and DA clients inside a running action. Shared by the web service, the event
 * handler, the reconcile job and the admin action so each sets them up the same way.
 */
const { getStore } = require('../store');
const ims = require('../ims');
const { createAemClient } = require('./aemAuthor');
const { createDaClient } = require('./daClient');
const { createSheetStore } = require('./sheets');
const { createLock } = require('./lock');

/** AEM Author client using the host and credential in state key `config:aem` (same as core-poll). */
async function aemClient() {
  const store = await getStore();
  const cfg = await store.get('config:aem');
  if (!cfg || !cfg.host) throw new Error('AEM is not configured (state key config:aem)');
  const durable = cfg.jwt || cfg.s2s;
  const token = durable ? await ims.getToken(store, durable) : cfg.token;
  if (!token) throw new Error('no AEM credential available');
  return createAemClient({ host: cfg.host, token });
}

// an unset manifest variable can arrive as its literal "$NAME"; treat that as not configured
const real = (v) => typeof v === 'string' && v.trim() !== '' && !v.startsWith('$');

/** DA client for the site's content, or null when no DA credential is configured. */
function daClient(params) {
  const s2s = real(params.DA_CLIENT_ID) && real(params.DA_CLIENT_SECRET) && real(params.DA_SCOPES);
  if (!s2s && !real(params.DA_TOKEN)) return null;
  return createDaClient({
    clientId: s2s ? params.DA_CLIENT_ID : '',
    clientSecret: s2s ? params.DA_CLIENT_SECRET : '',
    scopes: s2s ? params.DA_SCOPES : '',
    staticToken: real(params.DA_TOKEN) ? params.DA_TOKEN : '',
    publishKey: real(params.DA_PUBLISH_KEY) ? params.DA_PUBLISH_KEY : '',
    org: params.DA_ORG || 'ynaka-adobe',
    repo: params.DA_REPO || 'dealer-communications',
  });
}

/** Sheet storage in DA, or null when no DA credential is configured. */
async function sheetStore(params) {
  const da = daClient(params);
  return da ? createSheetStore(da, { lock: createLock(await getStore()) }) : null;
}

module.exports = { aemClient, sheetStore, daClient, real };
