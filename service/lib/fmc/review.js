/*
 * Review actions from the site, so a demo can move a communication through its workflow
 * without a terminal. The site is anonymous and so are these actions. Setting DC_REVIEW_CODE turns
 * on a demo code that anyone not signed in must give; leaving it empty (the default) means none.
 * Someone signed in (an employee, or a visitor who entered a guest access code) needs no code: the
 * edge function sets the user only for a real session, and only it knows the service key.
 * An anonymous visitor still needs the demo code.
 *
 *   action   effect
 *   reviewer  status -> REVIEWER PENDING
 *   final     status -> FINAL APPROVAL PENDING
 *   approve   generate the PDF with Guides, host it, status -> PUBLISHED (stays on the home list)
 *   archive   status -> ARCHIVED and move to the archive (a PUBLISHED communication only)
 *   restore   status -> PUBLISHED and back on the home list (an ARCHIVED communication only)
 *   reopen    status -> DRAFT (puts an approved communication back for another run)
 *
 * Real review happens in AEM workflows; this stands in for them (see admin.js).
 */
const crypto = require('crypto');
const {
  setStatus, attachPdf, setArchived, AdminError,
} = require('./admin');
const { topicPath } = require('./sync');
const { startJob, parseExtra, JobError } = require('./pdfjob');

const STATUS_FOR = { reviewer: 'REVIEWER PENDING', final: 'FINAL APPROVAL PENDING', reopen: 'DRAFT' };
const DEFAULT_HOST = 'publish-p154856-e1944736.adobeaemcloud.com';

/** True when the edge function vouched for the caller with a session (employee or guest code). */
const trustedCaller = (user) => String(user || '').trim() !== '';

class ReviewError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const same = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Where Guides published the PDF. The name depends on what was run and with which output:
 * a map is named after its file (the draft id) with `_Native PDF` or `-ditamap`; a topic is
 * named after its title. Each is tried in turn, on the configured AEM publish host only.
 */
async function findPdfUrl(aem, id, host, fetchImpl) {
  const base = `https://${host}/content/dam/fmdita-outputs/pdfs`;
  const probe = async (u) => { try { return (await fetchImpl(u, { method: 'HEAD', redirect: 'follow' })).ok; } catch (e) { return false; } };
  const byId = [`${base}/${id}_Native%20PDF.pdf`, `${base}/${id}-ditamap.pdf`];
  for (const u of byId) {
    // eslint-disable-next-line no-await-in-loop
    if (await probe(u)) return u;
  }
  const meta = await aem.getMetadata(topicPath(id));
  const title = meta && (meta['dc:title'] || meta.fmcTitle);
  const byTitle = title ? `${base}/${slug(title)}_Native%20PDF.pdf` : '';
  return byTitle && await probe(byTitle) ? byTitle : '';
}

/**
 * @param {{id:string, action:string, code:string}} req
 * @param {{aem:object, sheets:object, da:object, secret:string, host?:string, fetchImpl?:Function}} deps
 */
async function handleReview({ id, action, code }, {
  aem, sheets, da, secret, host = DEFAULT_HOST, fetchImpl = fetch, employee = false, output, outputParams, styles,
}, now = new Date()) {
  // Open to anonymous visitors by default. If a demo code is configured (DC_REVIEW_CODE), anyone
  // who is not signed in must give it; signing in always works.
  if (!employee && secret && !same(code, secret)) throw new ReviewError(403, 'incorrect demo code');
  if (!sheets || !da) throw new ReviewError(503, 'sheet storage is not configured');
  try {
    if (action === 'approve') {
      try {
        // generate a fresh PDF from the map; the poller hosts it and approves when it is done
        return await startJob(aem, sheets, id, now, { output, extra: parseExtra(outputParams), styles });
      } catch (e) {
        if (!(e instanceof JobError) || e.status === 404) throw e;
        // the service account may not be allowed to start workflows: use a PDF that already exists
        const url = await findPdfUrl(aem, id, host, fetchImpl);
        if (!url) throw new ReviewError(e.status, `${e.message}. Generate the PDF in AEM Guides, then approve again.`);
        return attachPdf(aem, sheets, da, { id, url }, now, fetchImpl);
      }
    }
    if (action === 'archive') return await setArchived(aem, sheets, { id, archived: true }, now);
    if (action === 'restore') return await setArchived(aem, sheets, { id, archived: false }, now);
    if (STATUS_FOR[action]) return await setStatus(aem, sheets, { id, status: STATUS_FOR[action] }, now);
    throw new ReviewError(400, 'unknown action');
  } catch (e) {
    if (e instanceof JobError) throw new ReviewError(e.status, e.message);
    if (e instanceof AdminError) throw new ReviewError(/no such/.test(e.message) ? 404 : 409, e.message);
    throw e;
  }
}

module.exports = {
  handleReview, ReviewError, findPdfUrl, trustedCaller, STATUS_FOR,
};
