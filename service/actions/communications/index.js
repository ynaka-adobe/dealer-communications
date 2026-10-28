/*
 * dealer-communications — the service behind the Dealer Communications site.
 *
 * Called only by the site's edge function (never by browsers), which adds two headers:
 *   x-fmc-key   shared secret, compared with the DC_ACTION_SECRET input (fail closed)
 *   x-fmc-user  the signed-in user's id, recorded as the author
 *
 * Routes (relative to the action URL):
 *   GET  /communications?type=active|archive
 *   POST /communications
 *   GET  /communications/{fileName}
 *   GET  /communications/{id}/status
 *   POST /communications/{id}/review   {action, code}  demo review actions (see lib/fmc/review.js)
 *
 * AEM host and credential come from app state key `config:aem` (the same one core-poll
 * uses), so no credential is placed in this action's inputs.
 */
const crypto = require('crypto');
const { getStore } = require('../../lib/store');
const { handle } = require('../../lib/fmc/communications');
const {
  aemClient, sheetStore, daClient, real,
} = require('../../lib/fmc/runtime');
const { handleReview, ReviewError, trustedCaller } = require('../../lib/fmc/review');
const { loadForEdit, loadForCopy, updateCommunication } = require('../../lib/fmc/edit');
const { HttpError } = require('../../lib/fmc/communications');
const { allowAnonymousCreate } = require('../../lib/fmc/limits');

const respond = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body,
});

const equalSecret = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

function parseBody(raw) {
  if (raw == null || raw === '') return undefined;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) { /* maybe base64 */ }
  try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch (e) { return null; }
}

async function main(params) {
  const headers = params.__ow_headers || {};
  if (!params.DC_ACTION_SECRET) return respond(503, { error: 'service not configured' });
  if (!equalSecret(headers['x-fmc-key'], params.DC_ACTION_SECRET)) return respond(401, { error: 'unauthorized' });

  const method = String(params.__ow_method || 'get').toUpperCase();
  const body = parseBody(params.__ow_body);
  if (body === null) return respond(400, { error: 'invalid json' });
  const query = Object.fromEntries(new URLSearchParams(params.__ow_query || ''));

  const review = method === 'POST' && /^\/communications\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/review$/.test(params.__ow_path || '');
  if (review) {
    // its own, generous cap: a wrong-code guess still costs one of these
    const verdict = await allowAnonymousCreate(await getStore(), headers['x-fmc-client'], new Date(), { clientPerHour: 60, perDay: 1000 }, 'review');
    if (!verdict.ok) return { ...respond(429, { error: 'too many requests, please try again later' }), headers: { 'Content-Type': 'application/json', 'Retry-After': String(verdict.retryAfter) } };
    try {
      const id = params.__ow_path.split('/')[2];
      const employee = trustedCaller(headers['x-fmc-user']);
      // what the edge function told us about the caller, not who they are or what they typed
      console.log(`fmc review ${body && body.action} user=${headers['x-fmc-user'] ? (employee ? 'employee' : 'guest') : 'none'} code=${body && body.code ? 'given' : 'none'}`); // eslint-disable-line no-console
      const result = await handleReview({ id, action: body && body.action, code: body && body.code }, {
        aem: await aemClient(),
        sheets: await sheetStore(params),
        da: daClient(params),
        secret: real(params.DC_REVIEW_CODE) ? params.DC_REVIEW_CODE : '',
        host: real(params.DC_PUBLISH_HOST) ? params.DC_PUBLISH_HOST : undefined,
        employee,
        output: real(params.DC_PDF_OUTPUT) ? params.DC_PDF_OUTPUT : undefined,
        outputParams: real(params.DC_PDF_PARAMS) ? params.DC_PDF_PARAMS : undefined,
      });
      return respond(200, { id, status: result.status, ...(result.pdf ? { pdf: result.pdf } : {}) });
    } catch (err) {
      // `caller` says how the edge function identified the caller; it is never their name
      if (err instanceof ReviewError) return respond(err.status, { error: err.message, caller: headers['x-fmc-user'] ? (headers['x-fmc-user'] === 'guest' ? 'guest' : 'employee') : 'none' });
      console.error('fmc review error', err && err.message); // eslint-disable-line no-console
      return respond(502, { error: 'upstream error' });
    }
  }

  // editing: load a draft's form, or save it back (see lib/fmc/edit.js)
  const editLoad = method === 'GET' && query.edit && /^\/communications\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(params.__ow_path || '');
  const copyLoad = method === 'GET' && query.copy && /^\/communications\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(params.__ow_path || '');
  const editSave = method === 'PUT' && query.submit && /^\/drafts\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(params.__ow_path || '');
  if (copyLoad) {
    try {
      return respond(200, await loadForCopy(await aemClient(), await sheetStore(params), decodeURIComponent(params.__ow_path.split('/')[2])));
    } catch (err) {
      if (err instanceof HttpError) return respond(err.status, { error: err.message });
      console.error('fmc copy error', err && err.message); // eslint-disable-line no-console
      return respond(502, { error: 'upstream error' });
    }
  }
  if (editLoad || editSave) {
    const who = String(headers['x-fmc-user'] || '').trim();
    if (editSave && !who) {
      // saving writes to AEM, so an anonymous caller shares the cap that step saves use
      const verdict = await allowAnonymousCreate(await getStore(), headers['x-fmc-client'], new Date(), {
        clientPerHour: Number(params.DC_SAVE_PER_HOUR), perDay: Number(params.DC_SAVE_PER_DAY),
      }, 'save');
      if (!verdict.ok) return { ...respond(429, { error: 'demo limit reached, please try again later' }), headers: { 'Content-Type': 'application/json', 'Retry-After': String(verdict.retryAfter) } };
    }
    try {
      const id = decodeURIComponent(params.__ow_path.split('/')[2]);
      const aem = await aemClient();
      const sheets = await sheetStore(params);
      const user = String(headers['x-fmc-user'] || '').trim();
      const result = editLoad
        ? await loadForEdit(aem, sheets, id, user, headers['x-fmc-client'])
        : await updateCommunication(aem, sheets, id, body, user, headers['x-fmc-client']);
      return respond(200, result);
    } catch (err) {
      if (err instanceof HttpError) return respond(err.status, { error: err.message, ...(err.problems ? { problems: err.problems } : {}) });
      console.error('fmc edit error', err && err.message); // eslint-disable-line no-console
      return respond(502, { error: 'upstream error' });
    }
  }

  // anonymous visitors may create drafts on the demo site, so bound how many (see lib/fmc/limits.js)
  const user = String(headers['x-fmc-user'] || '').trim();
  const isSave = method === 'PUT' && /^\/drafts\//.test(params.__ow_path || '');
  if ((method === 'POST' || isSave) && !user) {
    const verdict = await allowAnonymousCreate(await getStore(), headers['x-fmc-client'], new Date(), {
      clientPerHour: Number(isSave ? params.DC_SAVE_PER_HOUR : params.DC_CLIENT_PER_HOUR),
      perDay: Number(isSave ? params.DC_SAVE_PER_DAY : params.DC_PER_DAY),
    }, isSave ? 'save' : 'create');
    if (!verdict.ok) {
      return { ...respond(429, { error: 'demo limit reached, please try again later', scope: verdict.scope }), headers: { 'Content-Type': 'application/json', 'Retry-After': String(verdict.retryAfter) } };
    }
  }

  try {
    const result = await handle({
      method, path: params.__ow_path || '', query, body, user, client: headers['x-fmc-client'],
    }, await aemClient(), await sheetStore(params));
    return respond(result.status, result.body);
  } catch (err) {
    console.error('dealer-communications error', err && err.message); // eslint-disable-line no-console
    // the underlying message (never a secret) is returned only to a trusted caller that asks for it;
    // the site's edge function does not, so browsers never see it
    return respond(502, { error: 'upstream error', ...(headers['x-fmc-debug'] ? { detail: String((err && err.message) || err).slice(0, 300) } : {}) });
  }
}

exports.main = main;
