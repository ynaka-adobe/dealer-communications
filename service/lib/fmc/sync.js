/*
 * Keeps the two list sheets in step with AEM, which owns each communication's workflow status.
 *
 *   - handleEvent: an AEM Assets event for one of our topics -> re-read that asset and update its row
 *   - reconcile:   compare every topic in AEM with both sheets and repair any drift
 *
 * An event is only a hint that something changed. The handler never uses event content beyond the
 * asset path: the row always comes from the asset's real metadata read from AEM. A forged or
 * replayed event can therefore only cause a harmless re-sync of an existing asset.
 *
 * Placement: ACTIVE statuses live in /data/notifications, ARCHIVE statuses in /data/archive. Rows
 * with no aemPath (the sample rows, and drafts saved step by step but not yet submitted) are not
 * AEM-backed, so neither the event handler nor the reconcile ever removes them.
 */
const { ROOT, ACTIVE, ARCHIVE } = require('./communications');

const TOPIC = new RegExp(`^${ROOT.replace(/\//g, '\\/')}\\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\\/\\1\\.dita$`);
const MAX_REMOVALS = 25;
const QUERY_LIMIT = 500;

const topicPath = (id) => `${ROOT}/${id}/${id}.dita`;

/** The communication id for a topic path under our folder, or null for anything else. */
function topicIdFromPath(path) {
  const m = TOPIC.exec(String(path || ''));
  return m ? m[1] : null;
}

/** Which sheet a row belongs on, from its status (a row or a status). */
const placement = (x) => (ARCHIVE.includes(typeof x === 'string' ? x : x.status) ? 'archive' : 'active');

/** The sheet row for a communication, from its AEM asset metadata. */
function rowFromMetadata(id, meta, path = topicPath(id)) {
  return {
    id,
    fileName: id,
    title: meta['dc:title'] || meta.fmcTitle || id,
    status: meta.fmcStatus || 'DRAFT',
    reviewer: meta.fmcReviewer || '-',
    author: meta.fmcAuthor || '-',
    created: String(meta.fmcCreated || '').slice(0, 19),
    modified: String(meta.fmcModified || meta.fmcCreated || '').slice(0, 19),
    locked: 'false',
    aemPath: path,
    pdf: meta.fmcPdf || '',
    note: meta.fmcStatus === 'PDF ERROR' ? String(meta.fmcPdfError || '').slice(0, 200) : '',
    pdfTemplate: meta.fmcPdfStyle === 'adobe' ? 'Adobe' : 'Dealer Communications',
  };
}

/**
 * Pick out an AEM Assets event for one of our topics.
 * @returns {{id:string, code:string, fields:string[]|null}|null} null when it is not ours
 */
function eventFor(raw) {
  const data = (raw && raw.data) || {};
  const repo = data.repositoryMetadata || {};
  const id = topicIdFromPath(repo['repo:path'] || data.assetPath || data.path);
  if (!id) return null;
  const code = String((raw && (raw.type || raw.event_code)) || '');
  // for metadata updates, which properties changed (when the event says)
  let fields = null;
  const meta = data.assetMetadata || {};
  const names = new Set();
  const updated = meta['event:updated'];
  const created = meta['event:created'];
  if (updated && typeof updated === 'object' && !Array.isArray(updated)) Object.keys(updated).forEach((k) => names.add(k));
  if (Array.isArray(created)) created.forEach((f) => { if (typeof f === 'string') names.add(f); });
  else if (created && typeof created === 'object') Object.keys(created).forEach((k) => names.add(k));
  if (names.size) fields = [...names];
  return { id, code, fields };
}

/**
 * Whether an event can change what the sheets show. Guides keeps rewriting its own metadata after
 * processing; those updates are skipped. When the event does not say what changed, act.
 */
function worthSyncing(evt) {
  if (!evt) return false;
  if (/metadata_updated$/.test(evt.code) && evt.fields) {
    return evt.fields.some((f) => /^fmc/.test(f) || f === 'dc:title');
  }
  return true;
}

/** Re-read one asset and bring its row, and only its row, in line. */
async function syncOne(aem, sheets, id, now = new Date()) {
  const meta = await aem.getMetadata(topicPath(id));
  if (!meta) {
    // the asset is gone: drop its row from both sheets
    return sheets.applyChanges({ active: { remove: [id] }, archive: { remove: [id] } }, now)
      .then((r) => ({ id, action: 'removed', result: r }));
  }
  const row = rowFromMetadata(id, meta);
  const to = placement(row);
  const from = to === 'active' ? 'archive' : 'active';
  const result = await sheets.applyChanges({ [to]: { upsert: [row] }, [from]: { remove: [id] } }, now);
  return { id, action: 'synced', placement: to, result };
}

/**
 * syncOne for callers whose own change is already saved in AEM: a failed sheet update does not
 * undo or fail that change. The row is repaired by the next event or by the 15-minute reconcile.
 */
async function syncSafely(aem, sheets, id, now = new Date()) {
  try {
    return await syncOne(aem, sheets, id, now);
  } catch (e) {
    console.error(`sheet sync for ${id} failed, left for reconcile: ${e && e.message}`); // eslint-disable-line no-console
    return { id, action: 'pending', error: String((e && e.message) || e).slice(0, 160) };
  }
}

async function handleEvent(raw, aem, sheets, now = new Date()) {
  const evt = eventFor(raw);
  if (!evt) return { ignored: 'not a communication topic' };
  if (!worthSyncing(evt)) return { ignored: 'no communication fields changed', id: evt.id };
  return syncOne(aem, sheets, evt.id, now);
}

const differs = (a, b) => ['title', 'status', 'reviewer', 'author', 'aemPath', 'pdf', 'note'].some((k) => String(a[k] || '') !== String(b[k] || ''));

/**
 * Compare AEM with both sheets and repair drift in one batched change.
 * Deletions are guarded: nothing is removed when the AEM query may be truncated, and a run that
 * would remove an implausible share of AEM-backed rows is treated as an AEM problem, not a change.
 */
async function reconcile(aem, sheets, now = new Date()) {
  const hits = await aem.query({ path: ROOT, statuses: [...ACTIVE, ...ARCHIVE], limit: QUERY_LIMIT });
  const inAem = new Map();
  hits.forEach((h) => {
    const id = topicIdFromPath(h.path);
    if (id) inAem.set(id, rowFromMetadata(id, h.metadata || {}, h.path));
  });
  const truncated = hits.length >= QUERY_LIMIT;

  const have = await sheets.readAll();
  const changes = { active: { upsert: [], remove: [] }, archive: { upsert: [], remove: [] } };
  const report = { checked: inAem.size, upserted: 0, moved: 0, removed: 0, skippedRemovals: '' };

  inAem.forEach((row, id) => {
    const to = placement(row);
    const from = to === 'active' ? 'archive' : 'active';
    const current = have[to].find((r) => r.id === id);
    if (!current || differs(current, row)) {
      changes[to].upsert.push(row);
      report.upserted += 1;
    }
    if (have[from].some((r) => r.id === id)) {
      changes[from].remove.push(id);
      report.moved += 1;
    }
  });

  // AEM-backed rows (they carry an aemPath) whose asset no longer exists
  const stale = [];
  ['active', 'archive'].forEach((name) => have[name].forEach((r) => {
    if (r.aemPath && !inAem.has(r.id)) stale.push({ name, id: r.id });
  }));
  const backed = ['active', 'archive'].reduce((n, name) => n + have[name].filter((r) => r.aemPath).length, 0);
  if (stale.length) {
    if (truncated) report.skippedRemovals = 'query hit its limit';
    else if (stale.length > MAX_REMOVALS || (backed >= 5 && stale.length > backed / 2)) report.skippedRemovals = `${stale.length} of ${backed} AEM-backed rows look gone`;
    else {
      stale.forEach((s) => changes[s.name].remove.push(s.id));
      report.removed = stale.length;
    }
  }

  const any = ['active', 'archive'].some((n) => changes[n].upsert.length || changes[n].remove.length);
  report.written = any ? await sheets.applyChanges(changes, now) : 'nothing to change';
  return report;
}

module.exports = {
  topicIdFromPath, rowFromMetadata, eventFor, worthSyncing, syncOne, syncSafely, handleEvent, reconcile, placement, topicPath, MAX_REMOVALS, QUERY_LIMIT,
};
