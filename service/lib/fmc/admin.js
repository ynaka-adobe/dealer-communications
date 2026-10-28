/*
 * Operator operations for the communications service, run from a non-web action so they are
 * never reachable from the internet: only someone holding the runtime credentials can call them.
 * set-status stands in for a workflow step until AEM workflows exist, and drives demos.
 */
const {
  ACTIVE, ARCHIVE, ROOT, mapName,
} = require('./communications');
const { buildMap } = require('./dita');
const { setupGuides } = require('./guides');
const { hostAndApprove, PdfError } = require('./pdfhost');
const {
  startJob, finishJob, pollAll, parseExtra, JobError,
} = require('./pdfjob');
const { seedBatch } = require('./seed');
const { deployTemplate } = require('./template');
const { sidebarSections } = require('./dita');
const { stateFromMetadata } = require('./edit');
const {
  topicIdFromPath, syncOne, syncSafely, reconcile, topicPath,
} = require('./sync');

const STATUSES = [...ACTIVE, ...ARCHIVE];

class AdminError extends Error {}

/**
 * Set a communication's workflow status in AEM, then (by default) sync its row at once instead
 * of waiting for the AEM event.
 */
async function setStatus(aem, sheets, { id, status, sync = true }, now = new Date()) {
  if (!topicIdFromPath(topicPath(String(id || '')))) throw new AdminError('invalid id');
  if (!STATUSES.includes(status)) throw new AdminError(`status must be one of: ${STATUSES.join(', ')}`);
  const path = topicPath(id);
  if (!(await aem.getMetadata(path))) throw new AdminError('no such communication in AEM');
  const stamp = now.toISOString().slice(0, 19);
  await aem.setMetadata(path, { fmcStatus: status, fmcModified: stamp });
  const out = { id, status, aem: 'updated' };
  if (sync && sheets) out.sheet = await syncSafely(aem, sheets, id, now);
  return out;
}

/** Create the DITA map for a communication that was submitted without one. */
async function addMap(aem, { id }) {
  if (!topicIdFromPath(topicPath(String(id || '')))) throw new AdminError('invalid id');
  const meta = await aem.getMetadata(topicPath(id));
  if (!meta) throw new AdminError('no such communication in AEM');
  const folder = topicPath(id).replace(/\/[^/]+$/, '');
  if (await aem.getMetadata(`${folder}/${mapName(id)}`)) return { id, map: 'already there' };
  await aem.uploadText(folder, mapName(id), buildMap(id, meta['dc:title'] || meta.fmcTitle || id), 'application/dita+xml');
  return { id, map: 'created', path: `${folder}/${mapName(id)}` };
}

const DRAFT_ID = /^DRAFT-\d{14}-[a-z0-9]{4}$/;

/**
 * Delete a communication made on the demo site: its AEM folder (topic, preview, map), its rows in
 * both sheets, its saved form state and any hosted PDF. Needs `confirm: 'yes'` and only accepts
 * ids the site generates, so it cannot reach anything else. AEM goes first: if that fails nothing
 * else is touched, and the sheets are never left pointing at a missing asset.
 */
async function deleteCommunication(aem, sheets, da, { id, confirm }, now = new Date()) {
  if (!sheets || !da) throw new AdminError('sheet storage is not configured');
  if (!DRAFT_ID.test(String(id || ''))) throw new AdminError('only draft ids from the site can be deleted');
  if (confirm !== 'yes') throw new AdminError('pass confirm=yes to delete');
  const folder = topicPath(id).replace(/\/[^/]+$/, '');
  const out = { id, aem: (await aem.deleteFolder(folder)) ? 'deleted' : 'not found' };
  out.sheets = await sheets.applyChanges({ active: { remove: [id] }, archive: { remove: [id] } }, now);
  await sheets.deleteDraft(id);
  const pdf = `pdfs/${String(id).toLowerCase()}.pdf`;
  await da.delete(pdf);
  await da.unpublish(pdf);
  return out;
}

const PDF_HOST = /^[a-z0-9-]+\.adobeaemcloud\.com$/;

/**
 * Take a finished Guides PDF from AEM, host it on the site (so it can open in the browser and be
 * downloaded from the site's own origin) and approve the communication: it moves to the archive
 * with a link to the PDF. The AEM publish URL itself forces a download and refuses framing.
 */
async function attachPdf(aem, sheets, da, { id, url, status = 'PUBLISHED' }, now = new Date(), fetchImpl = fetch) {
  if (!sheets || !da) throw new AdminError('sheet storage is not configured');
  if (!topicIdFromPath(topicPath(String(id || '')))) throw new AdminError('invalid id');
  if (!['PUBLISHED', 'APPROVED'].includes(status)) throw new AdminError('status must be one of: PUBLISHED, APPROVED');
  let src;
  try { src = new URL(String(url)); } catch (e) { throw new AdminError('invalid url'); }
  if (!PDF_HOST.test(src.hostname)) throw new AdminError('the PDF must come from an adobeaemcloud.com host');
  src.protocol = 'https:';
  const path = topicPath(id);
  if (!(await aem.getMetadata(path))) throw new AdminError('no such communication in AEM');
  const res = await fetchImpl(src, { redirect: 'follow' });
  if (!res.ok) throw new AdminError(`could not fetch the PDF (HTTP ${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  try {
    return await hostAndApprove(aem, sheets, da, { id, bytes, status }, now);
  } catch (e) {
    if (e instanceof PdfError) throw new AdminError(e.message);
    throw e;
  }
}

/**
 * Put a communication's map back to the one the service generates (its topic and nothing else),
 * as a new version, so whatever was there before stays in the asset's history.
 */
async function resetMap(aem, { id }) {
  if (!topicIdFromPath(topicPath(String(id || '')))) throw new AdminError('invalid id');
  const meta = await aem.getMetadata(topicPath(id));
  if (!meta) throw new AdminError('no such communication in AEM');
  const folder = topicPath(id).replace(/\/[^/]+$/, '');
  await aem.uploadText(folder, mapName(id), buildMap(id, meta['dc:title'] || meta.fmcTitle || id), 'application/dita+xml', { newVersion: true });
  return { id, map: 'reset', path: `${folder}/${mapName(id)}` };
}

/**
 * Add the details column (field and dealer details) to a record whose topic was written before
 * the PDF layout had one. The message text is left exactly as it is: the details are built from
 * the record's metadata and inserted at the start of the topic body, as a new version.
 */
async function addSidebar(aem, { id }) {
  if (!topicIdFromPath(topicPath(String(id || '')))) throw new AdminError('invalid id');
  const meta = await aem.getMetadata(topicPath(id));
  if (!meta) throw new AdminError('no such communication in AEM');
  const text = await aem.getText(topicPath(id));
  if (text == null) throw new AdminError('the topic file was not found');
  if (text.includes('id="fmc-field-details"')) return { id, sidebar: 'already there' };
  if (!text.includes('<body>')) throw new AdminError('the topic has no body to add to');
  const state = stateFromMetadata(id, meta);
  const details = sidebarSections({ ...state, dealerComm: meta.fmcDealerComm === 'Yes' }).join('');
  const folder = topicPath(id).replace(/\/[^/]+$/, '');
  await aem.uploadText(folder, `${id}.dita`, text.replace('<body>', `<body>${details}`), 'application/dita+xml', { newVersion: true });
  return { id, sidebar: 'added' };
}

/**
 * Archive a published communication (status ARCHIVED, filed in the archive), or restore it
 * (status PUBLISHED, back on the home list). Nothing does this by itself.
 */
async function setArchived(aem, sheets, { id, archived }, now = new Date()) {
  if (!topicIdFromPath(topicPath(String(id || '')))) throw new AdminError('invalid id');
  const meta = await aem.getMetadata(topicPath(id));
  if (!meta) throw new AdminError('no such communication in AEM');
  if (archived && meta.fmcStatus !== 'PUBLISHED') throw new AdminError('only a published communication can be archived');
  if (!archived && meta.fmcStatus !== 'ARCHIVED') throw new AdminError('only an archived communication can be restored');
  const status = archived ? 'ARCHIVED' : 'PUBLISHED';
  await aem.setMetadata(topicPath(id), { fmcStatus: status, fmcModified: now.toISOString().slice(0, 19) });
  return { id, status, sheet: sheets ? await syncSafely(aem, sheets, id, now) : undefined };
}

/** Dispatch an admin request: { op: 'set-status' | 'sync' | 'reconcile', ... }. */
async function run(params, aem, sheets, now = new Date(), da = null) {
  switch (params.op) {
    case 'set-status': return setStatus(aem, sheets, params, now);
    case 'sync':
      if (!sheets) throw new AdminError('sheet storage is not configured');
      if (!topicIdFromPath(topicPath(String(params.id || '')))) throw new AdminError('invalid id');
      return syncOne(aem, sheets, params.id, now);
    case 'reconcile':
      if (!sheets) throw new AdminError('sheet storage is not configured');
      return reconcile(aem, sheets, now);
    case 'generate': return startJob(aem, sheets, params.id, now, { output: params.output || params.DC_PDF_OUTPUT, extra: parseExtra(params.extra || params.DC_PDF_PARAMS) }).catch((e) => { if (e instanceof JobError) throw new AdminError(e.message); throw e; });
    case 'finish': return finishJob(aem, sheets, da, params.id, now);
    case 'job-log': {
      // the Guides log of a communication's latest generation that reported errors (read only)
      if (!topicIdFromPath(topicPath(String(params.id || '')))) throw new AdminError('invalid id');
      const report = await aem.publishBeacon(topicPath(params.id).replace(/\.dita$/, '.ditamap'));
      const bad = (report.outputs || []).filter((o) => o.errorsExist || o.ditaotFaliure);
      const current = ((await aem.getMetadata(topicPath(params.id))) || {}).fmcPdfJob;
      const pick = bad.find((o) => o.jobId === current) || bad[0];
      if (!pick || !pick.ditaotLogFile) return { note: 'no output with errors', outputs: (report.outputs || []).length };
      const text = await aem.getOutputLog(pick.ditaotLogFile);
      const lines = text.split(/\r?\n/);
      const hits = lines.filter((l) => /error|exception|fail|invalid|not valid|DOTJ|PDFJ/i.test(l)).slice(0, 25);
      return { job: pick.jobId, lines: lines.length, problems: hits };
    }
    case 'beacon': {
      if (!topicIdFromPath(topicPath(String(params.id || '')))) throw new AdminError('invalid id');
      const out = await aem.publishBeacon(topicPath(params.id).replace(/\.dita$/, '.ditamap')).catch((e) => ({ failed: e.message }));
      const text = JSON.stringify(out);
      return { beacon: text.length > 4000 ? `${text.slice(0, 4000)}...` : out };
    }
    case 'generate-output': {
      // Experiment: start the PDF output of a SCRATCH draft's map the way the Generate button does.
      const id = String(params.id || '');
      if (!topicIdFromPath(topicPath(id))) throw new AdminError('invalid id');
      const meta = await aem.getMetadata(topicPath(id));
      if (!meta || !/scratch/i.test(String(meta['dc:title'] || meta.fmcTitle || ''))) throw new AdminError('only a draft with "scratch" in its title may be used');
      return aem.generateOutput(topicPath(id).replace(/\.dita$/, '.ditamap'), params.output || 'pdf').catch((e) => ({ failed: e.message, body: e.body }));
    }
    case 'deploy-template': return deployTemplate(aem, { dryRun: params.dry === 'true' || params.dry === true });
    case 'ls': {
      // read only: what a Guides template folder holds
      return { path: params.path, entries: await aem.listTemplates(String(params.path || '')) };
    }
    case 'cat': {
      // read only: a text file from a Guides template folder
      if (!/^\/content\/dam\/dita-templates\/[A-Za-z0-9_./ -]+\.(css|html|plt|tpl|xml|json|txt)$/.test(String(params.path || '')) || String(params.path).includes('..')) throw new AdminError('not a template text file');
      const text = await aem.getText(params.path);
      return { path: params.path, size: text == null ? null : text.length, text: text == null ? null : text.slice(0, Number(params.max) || 6000) };
    }
    case 'node': {
      const text = JSON.stringify(await aem.readNode(String(params.path || ''), params.depth));
      return { size: text.length, node: text.length > 9000 ? `${text.slice(0, 9000)}...` : JSON.parse(text) };
    }
    case 'try-preset': {
      // Experiment: copy the PDF preset node of a working map onto a SCRATCH draft, read it back.
      const id = String(params.id || '');
      if (!topicIdFromPath(topicPath(id))) throw new AdminError('invalid id');
      const meta = await aem.getMetadata(topicPath(id));
      if (!meta || !/^preset scratch/i.test(String(meta['dc:title'] || meta.fmcTitle || ''))) throw new AdminError('only a draft titled "preset scratch..." may be used');
      const mapOf = (x) => topicPath(x).replace(/\.dita$/, '.ditamap');
      const node = (x) => `${mapOf(x)}/jcr:content/metadata/namedoutputs/pdf`;
      const source = await aem.readNode(node(params.from), 1);
      const SKIP = new Set(['created', 'createdBy', 'lastModified', 'lastModifiedBy', 'jcr:primaryType']);
      const props = Object.fromEntries(Object.entries(source).filter(([k]) => !SKIP.has(k) && !k.startsWith('jcr:')));
      await aem.writePresetNode(node(id), props);
      const after = await aem.getPresets(mapOf(id)).catch((e) => ({ failed: e.message }));
      return { wrote: Object.keys(props).length, presetsAfter: ((after && after.localPresets) || []).map((p) => ({ outputName: p.outputName, outputType: p.outputType, targetPath: p.targetPath })), failed: after && after.failed };
    }
    case 'presets': {
      if (!topicIdFromPath(topicPath(String(params.id || '')))) throw new AdminError('invalid id');
      const found = await aem.getPresets(`${topicPath(params.id).replace(/\.dita$/, '.ditamap')}`).catch((e) => ({ failed: e.message, body: e.body }));
      if (params.global) {
        // every non-empty setting of one global preset (to see how it is configured)
        const one = ((found && found.globalPresets) || []).find((x) => x.outputName === params.global);
        return { id: params.id, preset: one ? Object.fromEntries(Object.entries(one).filter(([, v]) => v !== '' && v !== false && !(Array.isArray(v) && !v.length) && !(v && typeof v === 'object' && !Object.keys(v).length))) : null };
      }
      if (params.summary) {
        // a compact view: one line per preset
        const line = (scope) => (x) => ({
          scope, outputName: x.outputName, title: x.outputTitle, type: x.outputType, engine: x.pdfGenerator || x['fmdita-pdfGenerator'], default: x['preset-default'] || '', template: x.templatePath || x['fmdita-templatePath'] || '', ditaval: x.ditaValPath || x['fmdita-ditavalPath'] || '', ditavalType: x.ditaValType || x['fmdita-ditavalType'] || '',
        });
        return { id: params.id, presets: [...((found && found.globalPresets) || []).map(line('global')), ...((found && found.localPresets) || []).map(line('local'))] };
      }
      // `name` narrows the answer to one preset (by its outputName, e.g. pdf)
      const list = found && found.localPresets;
      const shown = params.name && Array.isArray(list) ? list.filter((p) => p.outputName === params.name) : found;
      const text = JSON.stringify(shown);
      return { id: params.id, size: text.length, presets: text.length > 9000 ? `${text.slice(0, 9000)}...` : shown };
    }
    case 'job': {
      // what the PDF job of one communication looks like right now (read only)
      const meta = await aem.getMetadata(topicPath(String(params.id || '')));
      if (!meta) throw new AdminError('no such communication in AEM');
      const job = meta.fmcPdfJob ? await aem.workflowInfo(meta.fmcPdfJob, 1).catch((e) => ({ error: e.message })) : null;
      return {
        id: params.id, status: meta.fmcStatus, started: meta.fmcPdfStarted, lastError: meta.fmcPdfError, modified: meta.fmcModified, job: job && { state: job.state, initiator: job.initiator, start: job.startTime, end: job.endTime, instance: meta.fmcPdfJob },
      };
    }
    case 'workflow': {
      const info = await aem.workflowInfo(params.job, params.depth);
      const text = JSON.stringify(info);
      return { size: text.length, info: text.length > 6000 ? `${text.slice(0, 6000)}...` : info };
    }
    case 'seed': return seedBatch(aem, Number(params.from) || 0, Number(params.to) || 0, now);
    case 'poll-pdfs': return pollAll(aem, sheets, da, now);
    case 'publish-approved': {
      // one time: records that were APPROVED become PUBLISHED and sit on the home list; the
      // sheets follow with one reconcile
      const hits = await aem.query({ path: ROOT, statuses: ['APPROVED'], limit: 200 });
      const stamp = now.toISOString().slice(0, 19);
      const done = [];
      for (const h of hits) {
        const id = topicIdFromPath(h.path);
        // eslint-disable-next-line no-await-in-loop
        if (id) { await aem.setMetadata(h.path, { fmcStatus: 'PUBLISHED', fmcModified: stamp }); done.push(id); }
      }
      return { changed: done.length, ids: done };
    }
    case 'archive': return setArchived(aem, sheets, { id: params.id, archived: true }, now);
    case 'restore': return setArchived(aem, sheets, { id: params.id, archived: false }, now);
    case 'migrate-archive': {
      // one time: published communications that were kept in the archive by the earlier flag
      // become ARCHIVED, so the status itself says where they are
      const have = await sheets.readAll();
      const hits = await aem.query({ path: ROOT, statuses: ['PUBLISHED'], limit: 200 });
      const changed = [];
      for (const h of hits) {
        const id = topicIdFromPath(h.path);
        // eslint-disable-next-line no-await-in-loop
        if (id && have.archive.some((r) => r.id === id)) { await aem.setMetadata(h.path, { fmcStatus: 'ARCHIVED', fmcArchived: '' }, { clearEmpty: true }); changed.push(id); }
      }
      return { changed: changed.length, ids: changed };
    }
    case 'publish-approved': {
      // one time: records that were APPROVED become PUBLISHED and sit on the home list; the
      // sheets follow with one reconcile
      const hits = await aem.query({ path: ROOT, statuses: ['APPROVED'], limit: 200 });
      const stamp = now.toISOString().slice(0, 19);
      const done = [];
      for (const h of hits) {
        const id = topicIdFromPath(h.path);
        // eslint-disable-next-line no-await-in-loop
        if (id) { await aem.setMetadata(h.path, { fmcStatus: 'PUBLISHED', fmcModified: stamp }); done.push(id); }
      }
      return { changed: done.length, ids: done };
    }
    case 'archive': return setArchived(aem, sheets, { id: params.id, archived: true }, now);
    case 'restore': return setArchived(aem, sheets, { id: params.id, archived: false }, now);
    case 'migrate-archive': {
      // one time: published communications that are in the archive today stay there on purpose
      const have = await sheets.readAll();
      const hits = await aem.query({ path: ROOT, statuses: ['PUBLISHED'], limit: 200 });
      const flagged = [];
      for (const h of hits) {
        const id = topicIdFromPath(h.path);
        // eslint-disable-next-line no-await-in-loop
        if (id && have.archive.some((r) => r.id === id) && !(h.metadata && h.metadata.fmcArchived)) { await aem.setMetadata(h.path, { fmcArchived: 'Yes' }); flagged.push(id); }
      }
      return { flagged: flagged.length, ids: flagged };
    }
    case 'delete': return deleteCommunication(aem, sheets, da, params, now);
    case 'add-map': return addMap(aem, params);
    case 'reset-map': return resetMap(aem, params);
    case 'add-sidebar': return addSidebar(aem, params);
    case 'setup-guides': return setupGuides(aem);
    case 'attach-pdf': return attachPdf(aem, sheets, da, params, now);
    case 'recent': return aem.recent({ path: params.path || '/content/dam', mime: params.mime || 'application/pdf', limit: Number(params.limit) || 15 });
    default: throw new AdminError('op must be set-status, sync, reconcile or recent');
  }
}

module.exports = {
  run, setStatus, attachPdf, addMap, resetMap, addSidebar, deleteCommunication, setArchived, AdminError, STATUSES };
