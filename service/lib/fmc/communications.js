/*
 * Communications service logic (the contract in dealer-communications/docs/communications-api.md).
 *
 * Each communication is a folder under ROOT holding a DITA topic (the source for AEM
 * Guides) and an HTML preview, with workflow state and routing as asset metadata on the
 * topic. All AEM access goes through the small `aem` interface so it can be tested
 * against a fake:
 *
 *   ensureFolder(path, title)            create a folder if missing
 *   uploadText(folder, name, text, mime) create an asset from text
 *   setMetadata(assetPath, props)        write asset metadata
 *   getMetadata(assetPath)               read asset metadata (flat object)
 *   getText(assetPath)                   read an asset's text content
 *   query({ path, statuses, limit })     [{ path, metadata }] for topics with these statuses
 */
const crypto = require('crypto');
const { buildDocuments, buildMap, plainText } = require('./dita');

const ROOT = '/content/dam/dealer-communications';
const ACTIVE = ['DRAFT', 'REVIEWER PENDING', 'FINAL APPROVAL PENDING', 'GENERATING PDF', 'PDF ERROR', 'PUBLISHED'];
// PUBLISHED stays on the home list until someone archives it: the Archive action sets ARCHIVED,
// so a finished communication is never filed away automatically.
const ARCHIVE = ['ARCHIVED', 'APPROVED', 'UNPUBLISH'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DRAFT_ID = /^DRAFT-\d{14}-[a-z0-9]{4}$/;
const MAX_DRAFT_BYTES = 256 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const str = (v, max = 255) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v, max = 40) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.trim().slice(0, 255)).slice(0, max) : []);
const html = (v) => (typeof v === 'string' ? v.slice(0, 200000) : '');
const isoLocal = (v) => (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/.test(v) ? v : '');

/** Validate and normalize the Create Draft payload; throws HttpError(422) on problems. */
function validateDraft(payload, user, now = new Date(), fileName = '') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400, 'body must be a JSON object');
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };

  const title = str(payload.title, 250);
  need(title, 'title is required');
  need(typeof payload.title !== 'string' || payload.title.trim().length <= 250, 'title is limited to 250 characters');

  const dealerComm = payload.dealerComm === 'Yes' || payload.dealerComm === true;
  const d = {
    title,
    dealerComm,
    division: str(payload.division),
    additionalDivisions: list(payload.additionalDivisions),
    channel: str(payload.channel),
    reviewer: str(payload.reviewer, 64),
    alternate: str(payload.alternate, 64),
    concurring: str(payload.concurring, 64),
    businessContact: str(payload.businessContact, 64),
    fieldPublish: isoLocal(str(payload.fieldPublish, 32)),
    fieldDue: isoLocal(str(payload.fieldDue, 32)),
    dealerDue: isoLocal(str(payload.dealerDue, 32)),
    fieldGroup: str(payload.fieldGroup),
    fieldLead: list(payload.fieldLead),
    fieldSupport: list(payload.fieldSupport),
    dealerGroup: str(payload.dealerGroup),
    dealerRoles: list(payload.dealerRoles),
    primaryDept: str(payload.primaryDept),
    additionalDepts: list(payload.additionalDepts),
    fieldOnly: html(payload.fieldOnly),
    action: html(payload.action),
    summary: html(payload.summary),
    questions: html(payload.questions),
    extraSections: Array.isArray(payload.extraSections)
      ? payload.extraSections.slice(0, 10).map((x) => ({ title: str(x && x.title, 120), html: html(x && x.html) })) : [],
  };
  // the signed-in user wins over anything the browser sends
  d.anonymous = !str(user, 64);
  d.author = str(user, 64) || str(payload.originator, 64);

  need(d.fieldPublish, 'fieldPublish is required (YYYY-MM-DD or YYYY-MM-DDTHH:mm)');
  need(plainText(d.summary).length <= 600, 'summary is limited to 600 characters');
  [['fieldOnly', 'field only information'], ['action', 'action requested'], ['summary', 'summary'], ['questions', 'questions']]
    .forEach(([k, label]) => need(plainText(d[k]).length <= 50000, `${label} is limited to 50000 characters`));
  if (dealerComm) {
    need(plainText(d.action), 'action requested is required for a dealer communication');
    need(plainText(d.summary), 'summary is required for a dealer communication');
    need(plainText(d.questions), 'questions are required for a dealer communication');
    need(d.dealerGroup, 'dealerGroup is required for a dealer communication');
  }
  if (problems.length) {
    const e = new HttpError(422, problems.join('; '));
    e.problems = problems;
    throw e;
  }

  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  d.fileName = fileName || `DRAFT-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
  const join = (a) => a.join('; ');
  d.metadata = {
    'dc:title': d.title,
    fmcTitle: d.title,
    fmcFileName: d.fileName,
    fmcStatus: 'DRAFT',
    fmcCreated: now.toISOString().slice(0, 19),
    fmcModified: now.toISOString().slice(0, 19),
    fmcDivision: d.division,
    fmcAdditionalDivisions: join(d.additionalDivisions),
    fmcChannel: d.channel,
    fmcReviewer: d.reviewer,
    fmcAlternate: d.alternate,
    fmcConcurring: d.concurring,
    fmcAuthor: d.author,
    fmcAnonymous: d.anonymous ? 'Yes' : '',
    fmcBusinessContact: d.businessContact,
    fmcFieldPublish: d.fieldPublish,
    fmcFieldDue: d.fieldDue,
    fmcDealerDue: d.dealerDue,
    fmcDealerComm: d.dealerComm ? 'Yes' : 'No',
    fmcFieldGroup: d.fieldGroup,
    fmcFieldLead: join(d.fieldLead),
    fmcFieldSupport: join(d.fieldSupport),
    fmcDealerGroup: d.dealerGroup,
    fmcDealerRoles: join(d.dealerRoles),
    fmcPrimaryDept: d.primaryDept,
    fmcAdditionalDepts: join(d.additionalDepts),
  };
  return d;
}

const topicPath = (name) => `${ROOT}/${name}/${name}.dita`;
const mapName = (name) => `${name}.ditamap`;
const previewPath = (name) => `${ROOT}/${name}/${name}.html`;

/** Who owns a draft: the signed-in user, else a hash of the caller address. */
const ownerOf = (user, client) => (user ? `user:${user}` : `anon:${crypto.createHash('sha256').update(String(client || 'unknown')).digest('hex').slice(0, 16)}`);

async function createDraft(aem, payload, user, now = new Date(), ctx = {}) {
  // a draft id chosen by the form ties its saved steps to this asset; it must be well formed,
  // unused in AEM, and (if steps were saved) owned by the same caller
  const wanted = typeof payload.draftId === 'string' ? payload.draftId : '';
  let fileName = '';
  if (wanted) {
    if (!DRAFT_ID.test(wanted)) throw new HttpError(400, 'invalid draftId');
    if (await aem.getMetadata(topicPath(wanted))) throw new HttpError(409, 'this draft was already submitted');
    if (ctx.sheets) {
      const saved = await ctx.sheets.getDraft(wanted);
      if (saved && saved.owner !== ownerOf(user, ctx.client)) throw new HttpError(403, 'not your draft');
    }
    fileName = wanted;
  }
  const d = validateDraft(payload, user, now, fileName);
  const { dita, preview } = buildDocuments(d);
  const folder = `${ROOT}/${d.fileName}`;
  const out = { id: d.fileName, fileName: d.fileName, status: 'DRAFT', assetPath: topicPath(d.fileName) };

  // The sheet row (a DA write and two publishes) is the slowest part and does not need the
  // upload to finish, so it runs alongside the AEM work. If the AEM work fails, the row is
  // taken back out. A sheet problem alone never fails the request: the asset exists.
  const row = {
    id: d.fileName, fileName: d.fileName, title: d.title, status: 'DRAFT', reviewer: d.reviewer, author: d.author, aemPath: out.assetPath,
  };
  const sheetWork = !ctx.sheets ? Promise.resolve(true) : (async () => {
    // one retry: a DA or publish hiccup would otherwise leave the row missing until the next reconcile
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await ctx.sheets.upsertActive(row, now);
        return true;
      } catch (e) {
        console.error(`sheet row for ${d.fileName} failed (attempt ${attempt}): ${e && e.message}`); // eslint-disable-line no-console
      }
    }
    return false;
  })();

  try {
    await aem.ensureFolder(ROOT, 'Dealer Communications');
    await aem.ensureFolder(folder, d.title);
    // the three files go up together; the map lets AEM Guides generate PDF/HTML from this
    // communication, and a failure there is reported (admin add-map repairs it), not fatal
    await Promise.all([
      aem.uploadText(folder, `${d.fileName}.dita`, dita, 'application/dita+xml'),
      aem.uploadText(folder, `${d.fileName}.html`, preview, 'text/html'),
      aem.uploadText(folder, mapName(d.fileName), buildMap(d.fileName, d.title), 'application/dita+xml').catch((e) => {
        console.error(`map for ${d.fileName} failed: ${e && e.message}`); // eslint-disable-line no-console
        out.map = 'not created';
      }),
    ]);
    await aem.setMetadata(topicPath(d.fileName), d.metadata);
  } catch (e) {
    // nothing usable was created: do not leave a row pointing at it
    if (await sheetWork && ctx.sheets && ctx.sheets.applyChanges) {
      await ctx.sheets.applyChanges({ active: { remove: [d.fileName] } }, now).catch(() => {});
    }
    throw e;
  }
  if (!(await sheetWork)) out.sheet = 'not updated';
  return out;
}

/** Save a draft's form state to its sheet document and list it; no AEM call. */
async function saveDraftProgress(sheets, id, payload, user, client, now = new Date()) {
  if (!sheets) throw new HttpError(503, 'draft storage is not configured');
  if (!DRAFT_ID.test(id)) throw new HttpError(400, 'invalid draft id');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400, 'body must be a JSON object');
  if (JSON.stringify(payload).length > MAX_DRAFT_BYTES) throw new HttpError(413, 'draft too large');
  const owner = ownerOf(user, client);
  const existing = await sheets.getDraft(id);
  if (existing && existing.owner !== owner) throw new HttpError(403, 'not your draft');

  const title = str(payload.title, 250);
  const author = str(user, 64) || str(payload.originator, 64);
  await sheets.putDraft(id, { id, owner, saved: now.toISOString(), state: payload });
  const sheet = await sheets.upsertActive({
    id, fileName: id, title: title || 'Untitled draft', status: 'DRAFT', reviewer: str(payload.reviewer, 64), author,
  }, now);
  return { id, saved: true, sheet };
}

const dateOf = (m, k) => (m[k] ? String(m[k]).slice(0, 19) : '');

function toRow(hit) {
  const m = hit.metadata || {};
  const name = m.fmcFileName || hit.path.split('/').slice(-2, -1)[0];
  return {
    id: name,
    fileName: name,
    title: m['dc:title'] || m.fmcTitle || name,
    status: m.fmcStatus || 'DRAFT',
    reviewer: m.fmcReviewer || '-',
    author: m.fmcAuthor || '-',
    created: dateOf(m, 'fmcCreated'),
    modified: dateOf(m, 'fmcModified') || dateOf(m, 'fmcCreated'),
    locked: false,
    pdf: m.fmcPdf || '',
  };
}

async function listCommunications(aem, type) {
  const statuses = type === 'archive' ? ARCHIVE : ACTIVE;
  const hits = await aem.query({ path: ROOT, statuses, limit: 200 });
  return hits.map(toRow);
}

async function getDetail(aem, fileName) {
  if (!NAME.test(fileName)) throw new HttpError(404, 'not found');
  const meta = await aem.getMetadata(topicPath(fileName));
  if (!meta) throw new HttpError(404, 'not found');
  const page = await aem.getText(previewPath(fileName));
  const body = (page || '').replace(/^[\s\S]*?<article>\s*<h1>[\s\S]*?<\/h1>/, '').replace(/<\/article>[\s\S]*$/, '');
  const nice = (iso) => {
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? '' : t.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  };
  const fields = [
    ['Field Publish Date', nice(meta.fmcFieldPublish)],
    ['Target Field Group', meta.fmcFieldGroup || ''],
    ['Field Lead', meta.fmcFieldLead || ''],
    ['Field Support', meta.fmcFieldSupport || ''],
  ];
  if (meta.fmcDealerComm === 'Yes') {
    fields.push(['Target Group', meta.fmcDealerGroup || ''], ['Target Roles', meta.fmcDealerRoles || ''],
      ['Target Department', [meta.fmcPrimaryDept, meta.fmcAdditionalDepts].filter(Boolean).join('; ')]);
  }
  // the Assets API does not always expose dc:title, so fall back to our copy, then the preview's <title>
  const fromPage = ((page || '').match(/<title>([^<]*)<\/title>/) || [])[1];
  const unescape = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return { title: meta['dc:title'] || meta.fmcTitle || (fromPage ? unescape(fromPage) : fileName), fields, body };
}

async function getStatus(aem, id) {
  if (!NAME.test(id)) throw new HttpError(404, 'not found');
  const meta = await aem.getMetadata(topicPath(id));
  if (!meta) throw new HttpError(404, 'not found');
  return { id, status: meta.fmcStatus || 'DRAFT', updated: dateOf(meta, 'fmcModified') || dateOf(meta, 'fmcCreated') };
}

/**
 * Route one request. path is relative to the API base, e.g. /communications/EFC1/status.
 * @returns {Promise<{status:number, body:any}>}
 */
async function handle({
  method, path, query = {}, body, user, client,
}, aem, sheets = null) {
  try {
    const parts = String(path || '').split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'communications' && parts[0] !== 'drafts') throw new HttpError(404, 'not found');
    if (method === 'GET' && parts.length === 1) return { status: 200, body: await listCommunications(aem, query.type === 'archive' ? 'archive' : 'active') };
    if (method === 'POST' && parts.length === 1) return { status: 201, body: await createDraft(aem, body, user, new Date(), { sheets, client }) };
    if (method === 'PUT' && parts.length === 2 && parts[0] === 'drafts') return { status: 200, body: await saveDraftProgress(sheets, parts[1], body, user, client) };
    if (parts[0] !== 'communications') throw new HttpError(405, 'method not allowed');
    if (method === 'GET' && parts.length === 3 && parts[2] === 'status') return { status: 200, body: await getStatus(aem, parts[1]) };
    if (method === 'GET' && parts.length === 2) return { status: 200, body: await getDetail(aem, parts[1]) };
    throw new HttpError(parts.length ? 405 : 404, 'not found');
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.message, ...(e.problems ? { problems: e.problems } : {}) } };
    throw e;
  }
}

module.exports = {
  mapName, topicPath, handle, validateDraft, createDraft, saveDraftProgress, listCommunications, getDetail, getStatus, ownerOf, ROOT, ACTIVE, ARCHIVE, HttpError,
};
