/*
 * Generate the PDF for an approved communication with AEM Guides, then host it.
 *
 *   startJob   asks Guides to generate the map's `pdf` output (the call behind the Generate
 *              button) and marks the topic GENERATING PDF; a second start while one runs does nothing
 *   finishJob  called on a short alarm: follows that generation in Guides' own status report and,
 *              when it is Finished, reads the PDF it names from Author, hosts it on the site and approves
 *
 * A failed, stuck or missing generation puts the communication at PDF ERROR with the reason in
 * `fmcPdfError`. It stays there until someone retries on purpose (the Retry PDF action), so
 * nothing that watches for FINAL APPROVAL PENDING can start the run over by itself.
 */
const { ROOT, mapName } = require('./communications');
const { topicPath, syncSafely } = require('./sync');
const { buildMap } = require('./dita');
const { hostAndApprove, PdfError } = require('./pdfhost');

// The output preset Guides generates, by its output name. It is a setting (DC_PDF_OUTPUT): the
// Native PDF preset's name is an id, while the local DITA-OT preset is simply `pdf`.
const OUTPUT = 'pdf';
const GENERATING = 'GENERATING PDF';
const FAILED = 'PDF ERROR';
const NOT_STARTED_MS = 3 * 60 * 1000; // Guides has not reported the job at all
const GIVE_UP_MS = 10 * 60 * 1000; // the job is still running

/** A settings string such as `nodejs=true&templatePath=/content/dam/...` as an object. */
function parseExtra(text) {
  return Object.fromEntries(new URLSearchParams(String(text || '').trim()));
}

class JobError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

const stamp = (d) => d.toISOString().slice(0, 19);
const mapOf = (id) => `${ROOT}/${id}/${mapName(id)}`;

async function ensureMap(aem, id, meta) {
  const path = mapOf(id);
  if (!(await aem.getMetadata(path))) {
    await aem.uploadText(`${ROOT}/${id}`, mapName(id), buildMap(id, meta['dc:title'] || meta.fmcTitle || id), 'application/dita+xml');
  }
  return path;
}

const POST_PROCESSING = '/var/workflow/models/dxml-asset-post-processing';

/**
 * Guides must recognize the map before it can generate anything: it marks the map
 * `guides:assetState = SUCCESS` once post-processing has run. That normally happens by itself a few
 * seconds after the upload; if it does not, the post-processing workflow is started once (as the
 * AEM team's flow does) and waited for. Resolves false when the map is still not ready.
 */
async function ensureRecognized(aem, mapPath, wait, sleepMs = 4000) {
  const ready = async () => {
    const node = await aem.readNode(`${mapPath}/jcr:content`, 1).catch(() => null);
    return !!node && node['guides:assetState'] === 'SUCCESS';
  };
  for (let i = 0; i < 3; i += 1) {
    if (await ready()) return true; // eslint-disable-line no-await-in-loop
    await wait(sleepMs); // eslint-disable-line no-await-in-loop
  }
  await aem.startWorkflow(POST_PROCESSING, mapPath).catch(() => null);
  for (let i = 0; i < 5; i += 1) {
    await wait(sleepMs); // eslint-disable-line no-await-in-loop
    if (await ready()) return true; // eslint-disable-line no-await-in-loop
  }
  return false;
}

/** The first error line of a failed generation's Guides log, as a short sentence. */
async function firstError(aem, job) {
  try {
    const text = await aem.getOutputLog(job.ditaotLogFile);
    const line = text.split(/\r?\n/).find((l) => /\[ERROR\]/.test(l) && !/Anttask|^\s*\[fop\]/.test(l)) || text.split(/\r?\n/).find((l) => /\[ERROR\]/.test(l));
    if (line) return line.replace(/^.*?\[ERROR\]:?\s*/, '').replace(/file:\/[^\s"]*\//g, '').trim().slice(0, 140);
  } catch (e) { /* no log to read: fall through */ }
  return `${job.outputStatus || 'errors'}; see the output log`;
}

async function startJob(aem, sheets, id, now = new Date(), { wait = (ms) => new Promise((r) => setTimeout(r, ms)), output = OUTPUT, extra = {} } = {}) {
  const meta = await aem.getMetadata(topicPath(id));
  if (!meta) throw new JobError('no such communication', 404);
  if (meta.fmcStatus === GENERATING) return { id, status: GENERATING, already: true };
  const mapPath = await ensureMap(aem, id, meta);
  if (!(await ensureRecognized(aem, mapPath, wait))) throw new JobError('Guides is still processing this map. Please try again in a moment.', 409);
  let started;
  try {
    try {
      started = await aem.generateOutput(mapPath, output || OUTPUT, extra);
    } catch (first) {
      // a map created moments ago may still be processing in Guides: wait briefly and ask once more
      if (first.status === 401 || first.status === 403) throw first;
      await wait(8000);
      started = await aem.generateOutput(mapPath, output || OUTPUT, extra);
    }
  } catch (e) {
    const err = new JobError(`could not start the PDF generation: ${e.message}`, e.status === 401 || e.status === 403 ? 403 : 502);
    err.cause = e;
    throw err;
  }
  if (!started || !started.success || !started.generationId) throw new JobError('Guides did not accept the PDF generation request', 502);
  await aem.setMetadata(topicPath(id), {
    fmcStatus: GENERATING, fmcModified: stamp(now), fmcPdfJob: started.generationId, fmcPdfStarted: now.toISOString(), fmcPdfError: '-',
  });
  await syncSafely(aem, sheets, id, now);
  return { id, status: GENERATING, job: started.generationId };
}

async function giveUp(aem, sheets, id, reason, now) {
  await aem.setMetadata(topicPath(id), { fmcStatus: FAILED, fmcModified: stamp(now), fmcPdfError: String(reason).slice(0, 200) });
  await syncSafely(aem, sheets, id, now);
  return { id, state: 'failed', reason };
}

/** One poll of one job. state: 'skip' | 'waiting' | 'failed' | 'done' */
async function finishJob(aem, sheets, da, id, now = new Date()) {
  const meta = await aem.getMetadata(topicPath(id));
  if (!meta || meta.fmcStatus !== GENERATING) return { id, state: 'skip' };
  const age = now - new Date(meta.fmcPdfStarted || 0);
  const report = await aem.publishBeacon(mapOf(id)).catch(() => null);
  const job = report && (report.outputs || []).find((o) => o.jobId === meta.fmcPdfJob);

  if (!job) {
    const queued = report && (report.queuedOutputs || []).length > 0;
    return age > (queued ? GIVE_UP_MS : NOT_STARTED_MS)
      ? giveUp(aem, sheets, id, 'Guides never reported the PDF generation (does the map have a "pdf" output preset?)', now)
      : { id, state: 'waiting', reason: queued ? 'queued' : 'not reported yet' };
  }
  if (job.errorsExist || job.ditaotFaliure || /fail|error|cancel/i.test(String(job.outputStatus))) {
    return giveUp(aem, sheets, id, `the PDF generation failed in Guides: ${await firstError(aem, job)}`, now);
  }
  if (job.outputStatus !== 'Finished' || !job.outputPath) {
    return age > GIVE_UP_MS ? giveUp(aem, sheets, id, 'the PDF generation took too long', now) : { id, state: 'waiting', reason: job.outputStatus || 'running' };
  }
  try {
    return { state: 'done', source: job.outputPath, ...(await hostAndApprove(aem, sheets, da, { id, bytes: await aem.getBinary(job.outputPath) }, now)) };
  } catch (e) {
    if (e instanceof PdfError) return giveUp(aem, sheets, id, e.message, now);
    throw e;
  }
}

/** Poll every communication that is generating. */
async function pollAll(aem, sheets, da, now = new Date()) {
  const hits = await aem.query({ path: ROOT, statuses: [GENERATING], limit: 50 });
  const out = [];
  for (const h of hits) {
    const id = (h.path.match(/\/([^/]+)\/\1\.dita$/) || [])[1];
    // eslint-disable-next-line no-await-in-loop
    if (id) out.push(await finishJob(aem, sheets, da, id, now).catch((e) => ({ id, state: 'error', reason: e.message })));
  }
  return { checked: out.length, results: out };
}

module.exports = {
  startJob, finishJob, pollAll, parseExtra, JobError, GENERATING, FAILED, OUTPUT,
};
