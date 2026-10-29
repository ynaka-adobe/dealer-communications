/*
 * The communications sheets and in-progress drafts, stored in DA.
 *
 *   /data/notifications.json   active communications (one row each)
 *   /data/archive.json         published and unpublished communications
 *   /data/drafts/<id>.json     the saved form state of a draft (never published)
 *
 * The site reads the two sheets as cached JSON. A row is written and the sheet republished only
 * when a row actually changes, so saving each form step does not republish every time.
 *
 * Several writers touch these sheets (site saves, AEM events, the scheduled reconcile). Every
 * write runs under one advisory lock (see lock.js) when a lock is supplied. The lock is best
 * effort, so rows are also keyed by id and idempotent to rewrite, and the reconcile repairs drift.
 */
const NOTIFICATIONS = 'data/notifications.json';
const ARCHIVE = 'data/archive.json';
const COLUMNS = ['id', 'fileName', 'title', 'status', 'reviewer', 'author', 'created', 'modified', 'locked', 'aemPath', 'pdf', 'note', 'pdfTemplate'];
const WIDTHS = [120, 120, 260, 220, 120, 120, 170, 170, 80, 260, 260, 300, 170];

// DA stores file names in lower case, so always address a draft document by its lower-case name
const draftPath = (id) => `data/drafts/${String(id).toLowerCase()}.json`;

const sheetOf = (rows) => ({
  total: rows.length, limit: rows.length, offset: 0, data: rows, ':colWidths': WIDTHS, ':sheetname': 'data', ':type': 'sheet',
});

const cell = (v) => (v == null ? '' : String(v));
const toRow = (r) => Object.fromEntries(COLUMNS.map((c) => [c, cell(r[c])]));
const same = (a, b) => ['title', 'status', 'reviewer', 'author', 'aemPath', 'locked', 'pdf', 'note', 'modified'].every((k) => cell(a[k]) === cell(b[k]));

const SHEET_PATHS = { active: NOTIFICATIONS, archive: ARCHIVE };

function createSheetStore(da, { lock = null } = {}) {
  const locked = (fn) => (lock ? lock.withLock('sheets', fn) : fn());
  // DA publishes an empty sheet as one blank row; that is not a communication, so drop it
  const rowsOf = async (path) => ((await da.getJson(path)) || sheetOf([])).data.map(toRow).filter((r) => r.id);

  return {
    async getDraft(id) { return da.getJson(draftPath(id)); },
    async putDraft(id, doc) { await da.putJson(draftPath(id), doc); },
    async deleteDraft(id) { await da.delete(draftPath(id)); },

    /** Current rows of both sheets: { active, archive }. */
    async readAll() {
      return { active: await rowsOf(NOTIFICATIONS), archive: await rowsOf(ARCHIVE) };
    },

    /**
     * Apply a batch of row changes to either sheet in one critical section, writing and
     * publishing each sheet at most once and only if it changed. A row moved between sheets is
     * added to its new sheet before it is removed from the old one.
     *
     * @param {{active?: {upsert?: object[], remove?: string[]}, archive?: {upsert?: object[], remove?: string[]}}} changes
     * @returns {Promise<{active: object, archive: object}>} counts per sheet
     */
    async applyChanges(changes, now = new Date()) {
      return locked(async () => {
        const stamp = now.toISOString().slice(0, 19);
        const result = {};
        // archive first: if the second write fails, the row exists in both places, not in neither
        for (const name of ['archive', 'active']) {
          const want = changes[name] || {};
          const upserts = want.upsert || [];
          const removals = new Set(want.remove || []);
          result[name] = { added: 0, updated: 0, removed: 0 };
          if (!upserts.length && !removals.size) continue; // eslint-disable-line no-continue
          // eslint-disable-next-line no-await-in-loop
          let rows = await rowsOf(SHEET_PATHS[name]);
          for (const r of upserts) {
            const i = rows.findIndex((x) => x.id === r.id);
            if (i === -1) {
              rows.unshift(toRow({ created: stamp, modified: stamp, locked: 'false', ...r }));
              result[name].added += 1;
            } else {
              const next = toRow({ ...rows[i], ...r });
              if (!same(rows[i], next)) {
                // honour AEM's own modified time only if it really moved; otherwise stamp the change
                rows[i] = { ...next, modified: r.modified && r.modified !== rows[i].modified ? r.modified : stamp };
                result[name].updated += 1;
              }
            }
          }
          const before = rows.length;
          rows = rows.filter((x) => !removals.has(x.id));
          result[name].removed = before - rows.length;
          const { added, updated, removed } = result[name];
          if (added || updated || removed) {
            // eslint-disable-next-line no-await-in-loop
            await da.putJson(SHEET_PATHS[name], sheetOf(rows));
            // eslint-disable-next-line no-await-in-loop
            await da.publish(SHEET_PATHS[name]);
          }
        }
        return result;
      });
    },

    /**
     * Insert or update one row in the notifications sheet; republish only if it changed.
     * @returns {Promise<'created'|'updated'|'unchanged'>}
     */
    async upsertActive(row, now = new Date()) {
      return locked(() => this.upsertActiveUnlocked(row, now));
    },

    async upsertActiveUnlocked(row, now = new Date()) {
      const sheet = (await da.getJson(NOTIFICATIONS)) || sheetOf([]);
      const rows = (sheet.data || []).map(toRow);
      const i = rows.findIndex((r) => r.id === row.id);
      const stamp = now.toISOString().slice(0, 19);
      if (i === -1) {
        rows.unshift(toRow({ created: stamp, modified: stamp, locked: 'false', ...row }));
      } else {
        const next = toRow({ ...rows[i], ...row });
        if (same(rows[i], next)) return 'unchanged';
        rows[i] = { ...next, modified: stamp };
      }
      await da.putJson(NOTIFICATIONS, sheetOf(rows));
      await da.publish(NOTIFICATIONS);
      return i === -1 ? 'created' : 'updated';
    },
  };
}

module.exports = { createSheetStore, NOTIFICATIONS, ARCHIVE, COLUMNS };
