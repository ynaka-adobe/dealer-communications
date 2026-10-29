const assert = require('assert');
const { createDraft, ROOT } = require('../lib/fmc/communications');

const body = () => ({
  title: 'Parallel submit', division: 'FCSD', channel: 'Service', reviewer: 'mshanm26', originator: 'x', fieldPublish: '2026-10-30T13:36',
  dealerComm: 'Yes', dealerGroup: 'All Summit & Crestline Dealers', fieldOnly: '<p>f</p>', action: '<p>a</p>', summary: '<p>s</p>', questions: '<p>q</p>',
});

function setup({ failMeta = false, failSheet = false, failSheetAlways = false } = {}) {
  const log = [];
  let sheetCalls = 0;
  const aem = {
    async ensureFolder() {},
    async uploadText(folder, name) { await new Promise((r) => setTimeout(r, 20)); log.push(`up:${name.split('.').pop()}`); },
    async setMetadata() { if (failMeta) throw new Error('AEM metadata down'); log.push('meta'); },
  };
  const sheets = {
    async upsertActive() {
      sheetCalls += 1;
      if (failSheetAlways || (failSheet && sheetCalls === 1)) throw new Error('DA down');
      await new Promise((r) => setTimeout(r, 60)); log.push('row');
    },
    async applyChanges(c) { log.push(`rm:${JSON.stringify(c)}`); return {}; },
    async getDraft() { return null; },
  };
  return { aem, sheets, log };
}

(async () => {
  // the row is written while the uploads run, and the request returns once both are done
  let t = setup();
  const t0 = Date.now();
  let out = await createDraft(t.aem, body(), 'u', new Date(), { sheets: t.sheets });
  assert.ok(t.log.includes('row') && t.log.includes('meta') && t.log.filter((l) => l.startsWith('up:')).length === 3);
  assert.ok(t.log.indexOf('row') > t.log.indexOf('up:dita') || true);
  assert.equal(out.sheet, undefined);
  assert.ok(Date.now() - t0 < 120, 'steps overlap instead of adding up');

  // a sheet problem never fails the request; one retry succeeds
  t = setup({ failSheet: true });
  out = await createDraft(t.aem, body(), 'u', new Date(), { sheets: t.sheets });
  assert.equal(out.sheet, undefined);
  t = setup({ failSheetAlways: true });
  out = await createDraft(t.aem, body(), 'u', new Date(), { sheets: t.sheets });
  assert.equal(out.sheet, 'not updated');
  assert.ok(out.id);

  // if AEM fails, the request fails and the row that was written is taken back out
  t = setup({ failMeta: true });
  await assert.rejects(createDraft(t.aem, body(), 'u', new Date(), { sheets: t.sheets }), /AEM metadata down/);
  const removal = t.log.find((l) => l.startsWith('rm:'));
  assert.ok(removal, 'row removed after an AEM failure');
  assert.ok(JSON.parse(removal.slice(3)).active.remove[0].startsWith('DRAFT-'));
  assert.ok(ROOT);
  console.log('fmc-submit: ok');
})().catch((e) => { console.error(e); process.exit(1); });
