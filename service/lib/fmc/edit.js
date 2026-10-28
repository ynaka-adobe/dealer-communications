/*
 * Editing a communication from the site: load its form, then save it back to the same AEM
 * asset (a new version of the topic, preview and map; same id, same status).
 *
 *   GET /communications/{id}?edit=1     the form state to fill the Create Draft form with
 *   PUT /drafts/{id}?submit=1           save the form back (the plain PUT only saves progress)
 *
 * Only a draft or a draft in review can be edited, and only by whoever made it; a signed-in
 * employee (never a guest) can edit any such draft. Older drafts have no saved form, so their
 * fields come from the asset's metadata and the body text starts empty.
 */
const {
  HttpError, ROOT, mapName, topicPath, validateDraft, ownerOf,
} = require('./communications');
const { buildDocuments, buildMap } = require('./dita');
const { syncOne } = require('./sync');

const EDITABLE = ['DRAFT', 'REVIEWER PENDING'];
const DRAFT_ID = /^DRAFT-\d{14}-[a-z0-9]{4}$/;
const split = (v) => String(v || '').split(';').map((s) => s.trim()).filter(Boolean);

/** Form fields from what the asset's metadata holds (no body text). */
function stateFromMetadata(id, m) {
  return {
    draftId: id,
    title: m.fmcTitle || m['dc:title'] || '',
    dealerComm: m.fmcDealerComm === 'Yes' ? 'Yes' : 'No',
    division: m.fmcDivision || '',
    additionalDivisions: split(m.fmcAdditionalDivisions),
    channel: m.fmcChannel || '',
    reviewer: m.fmcReviewer || '',
    alternate: m.fmcAlternate || '',
    concurring: m.fmcConcurring || '',
    originator: m.fmcAuthor || '',
    businessContact: m.fmcBusinessContact || '',
    fieldPublish: m.fmcFieldPublish || '',
    fieldDue: m.fmcFieldDue || '',
    dealerDue: m.fmcDealerDue || '',
    fieldGroup: m.fmcFieldGroup || '',
    fieldLead: split(m.fmcFieldLead),
    fieldSupport: split(m.fmcFieldSupport),
    dealerGroup: m.fmcDealerGroup || '',
    dealerRoles: split(m.fmcDealerRoles),
    primaryDept: m.fmcPrimaryDept || '',
    additionalDepts: split(m.fmcAdditionalDepts),
  };
}

async function authorize(aem, sheets, id, user, client) {
  if (!DRAFT_ID.test(String(id || ''))) throw new HttpError(404, 'not found');
  const meta = await aem.getMetadata(topicPath(id));
  if (!meta) throw new HttpError(404, 'not found');
  if (!EDITABLE.includes(meta.fmcStatus || 'DRAFT')) throw new HttpError(409, 'only a draft, or a draft in review, can be edited');
  const saved = sheets ? await sheets.getDraft(id) : null;
  const employee = Boolean(user) && user !== 'guest';
  if (!employee && !(saved && saved.owner === ownerOf(user, client))) throw new HttpError(403, 'not your draft');
  return { meta, saved };
}

async function loadForEdit(aem, sheets, id, user, client) {
  const { meta, saved } = await authorize(aem, sheets, id, user, client);
  const fromSaved = saved && saved.state && typeof saved.state === 'object';
  return {
    id, status: meta.fmcStatus || 'DRAFT', source: fromSaved ? 'saved' : 'metadata', state: fromSaved ? { ...saved.state, draftId: id } : stateFromMetadata(id, meta),
  };
}

/**
 * The form state of any communication, to start a new draft from it (Copy As New). Reading is
 * not restricted by status or owner (the content is already viewable on the site); the copy is
 * a brand-new draft when saved and the original is never touched.
 */
async function loadForCopy(aem, sheets, id) {
  if (!DRAFT_ID.test(String(id || ''))) throw new HttpError(404, 'not found');
  const meta = await aem.getMetadata(topicPath(id));
  if (!meta) throw new HttpError(404, 'not found');
  const saved = sheets ? await sheets.getDraft(id) : null;
  const fromSaved = saved && saved.state && typeof saved.state === 'object';
  const { draftId, ...state } = fromSaved ? saved.state : stateFromMetadata(id, meta);
  return { id, source: fromSaved ? 'saved' : 'metadata', title: meta.fmcTitle || meta['dc:title'] || '', state };
}

async function updateCommunication(aem, sheets, id, payload, user, client, now = new Date()) {
  if (!sheets) throw new HttpError(503, 'draft storage is not configured');
  const { meta, saved } = await authorize(aem, sheets, id, user, client);
  const d = validateDraft(payload, user, now, id);
  const { dita, preview } = buildDocuments(d);
  const folder = `${ROOT}/${id}`;
  const again = { newVersion: true };
  await Promise.all([
    aem.uploadText(folder, `${id}.dita`, dita, 'application/dita+xml', again),
    aem.uploadText(folder, `${id}.html`, preview, 'text/html', again),
    aem.uploadText(folder, mapName(id), buildMap(id, d.title), 'application/dita+xml', again).catch(() => {}),
  ]);
  // identity, status and who made it stay as they were
  const {
    fmcStatus, fmcCreated, fmcAuthor, fmcAnonymous, fmcFileName, ...changed
  } = d.metadata;
  await aem.setMetadata(topicPath(id), { ...changed, fmcModified: now.toISOString().slice(0, 19) }, { clearEmpty: true });
  await sheets.putDraft(id, {
    id, owner: (saved && saved.owner) || ownerOf(user, client), saved: now.toISOString(), state: payload,
  });
  await syncOne(aem, sheets, id, now).catch(() => {}); // the sheet row catches up (title, reviewer, modified)
  return { id, status: meta.fmcStatus || 'DRAFT', updated: true };
}

module.exports = {
  loadForEdit, loadForCopy, updateCommunication, stateFromMetadata, EDITABLE,
};
