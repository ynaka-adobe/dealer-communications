const assert = require('assert');
const {
  startJob, finishJob, pollAll, parseExtra,
} = require('../lib/fmc/pdfjob');
const { ROOT } = require('../lib/fmc/communications');

const ID = 'DRAFT-20261025160638-cc4s';
const topic = `${ROOT}/${ID}/${ID}.dita`;
const map = `${ROOT}/${ID}/${ID}.ditamap`;
const T0 = new Date('2026-10-25T20:00:00Z');
const minutes = (n) => new Date(T0.getTime() + n * 60000);
const pdf = Buffer.from('%PDF-1.4 body');
const JOB = 'job-123';
const OUT = '/content/dam/fmdita-outputs/pdfs/x-ditamap.pdf';

function setup({
  outputs = [], queued = [], bytes = pdf, meta, beaconFails = false, generate, recognizedAfter = 0,
} = {}) {
  const m = meta || { 'dc:title': 'T', fmcStatus: 'GENERATING PDF', fmcPdfJob: JOB, fmcPdfStarted: T0.toISOString() };
  const calls = { put: [], pub: [], changes: [], generated: [], workflows: [], reads: 0 };
  const aem = {
    async getMetadata(p) { return p === topic || p === map ? m : null; },
    async setMetadata(p, props) { Object.assign(m, props); },
    async uploadText() {},
    async readNode() { calls.reads += 1; return { 'guides:assetState': calls.reads > recognizedAfter ? 'SUCCESS' : 'PROCESSING' }; },
    async startWorkflow(model, payload) { calls.workflows.push([model, payload]); return '/var/workflow/instances/x'; },
    async generateOutput(mapPath, output) {
      calls.generated.push([mapPath, output]);
      if (generate) return generate();
      return { success: true, generationId: JOB };
    },
    async getOutputLog() { return '[map-reader] x [DOTJ036W][WARN] outside scope\n [pipeline] file:/opt/x/y/z.ditamap:5:56: [PDFX005F][ERROR]: The topic reference href="#null" could not be found.\n      [fop] [ERROR] Anttask - Error rendering fo file'; },
    async publishBeacon() { if (beaconFails) throw new Error('beacon down'); return { outputs, queuedOutputs: queued }; },
    async getBinary(p) { calls.read = p; return bytes; },
    async query() { return [{ path: topic, metadata: m }]; },
  };
  const da = { async putBinary(p, b) { calls.put.push([p, b.length]); }, async publish(p) { calls.pub.push(p); } };
  const sheets = { async applyChanges(c) { calls.changes.push(c); return {}; } };
  return { aem, da, sheets, calls, m };
}
const job = (over = {}) => ({
  jobId: JOB, outputName: 'pdf', outputStatus: 'Finished', outputPath: OUT, errorsExist: false, ditaotFaliure: false, ...over,
});

(async () => {
  // start: asks Guides for the pdf output of the map and records the job it names
  let t = setup({ meta: { 'dc:title': 'T', fmcStatus: 'FINAL APPROVAL PENDING' } });
  let r = await startJob(t.aem, t.sheets, ID, T0);
  assert.deepEqual(t.calls.generated, [[map, 'pdf']]);
  assert.equal(r.status, 'GENERATING PDF');
  assert.equal(t.m.fmcPdfJob, JOB);
  // the output preset is a setting: Native PDF is asked for by its own name, the default is `pdf`
  const named = setup({ meta: { 'dc:title': 'T', fmcStatus: 'FINAL APPROVAL PENDING' } });
  await startJob(named.aem, named.sheets, ID, T0, { output: 'c0c81768-native' });
  assert.deepEqual(named.calls.generated, [[map, 'c0c81768-native']]);

  // extra Generate parameters (Native PDF needs nodejs and a template path) are passed through
  const withExtra = setup({ meta: { 'dc:title': 'T', fmcStatus: 'FINAL APPROVAL PENDING' } });
  let seenExtra;
  withExtra.aem.generateOutput = async (m, o, e) => { seenExtra = e; return { success: true, generationId: JOB }; };
  await startJob(withExtra.aem, withExtra.sheets, ID, T0, { output: 'x', extra: parseExtra('nodejs=true&templatePath=/content/dam/dita-templates/pdf/') });
  assert.deepEqual(seenExtra, { nodejs: 'true', templatePath: '/content/dam/dita-templates/pdf/' });
  assert.deepEqual(parseExtra(''), {});

  // a second start while it runs asks for nothing
  r = await startJob(t.aem, t.sheets, ID, T0);
  assert.equal(r.already, true);
  assert.equal(t.calls.generated.length, 1);
  // Guides must recognize the map first: a map that becomes ready on its own is simply waited for
  const noWait = { wait: async () => {} };
  t = setup({ meta: { 'dc:title': 'T', fmcStatus: 'FINAL APPROVAL PENDING' }, recognizedAfter: 2 });
  r = await startJob(t.aem, t.sheets, ID, T0, noWait);
  assert.deepEqual([r.status, t.calls.workflows.length], ['GENERATING PDF', 0]);
  // one that does not is sent through post-processing once, then waited for
  t = setup({ meta: { 'dc:title': 'T', fmcStatus: 'FINAL APPROVAL PENDING' }, recognizedAfter: 5 });
  r = await startJob(t.aem, t.sheets, ID, T0, noWait);
  assert.deepEqual(t.calls.workflows, [['/var/workflow/models/dxml-asset-post-processing', map]]);
  assert.equal(r.status, 'GENERATING PDF');
  // one that never becomes ready is a clear, retryable message and nothing is generated
  t = setup({ meta: { 'dc:title': 'T', fmcStatus: 'FINAL APPROVAL PENDING' }, recognizedAfter: 999 });
  await assert.rejects(startJob(t.aem, t.sheets, ID, T0, noWait), (e) => e.status === 409 && /still processing/.test(e.message));
  assert.equal(t.calls.generated.length, 0);
  assert.equal(t.m.fmcStatus, 'FINAL APPROVAL PENDING');

  // a map that is still processing is asked again once; a refusal (403) is not retried
  let tries = 0;
  t = setup({ meta: { 'dc:title': 'T', fmcStatus: 'FINAL APPROVAL PENDING' }, generate: () => { tries += 1; if (tries === 1) { const e = new Error('HTTP 500'); e.status = 500; throw e; } return { success: true, generationId: JOB }; } });
  r = await startJob(t.aem, t.sheets, ID, T0, { wait: async () => {} });
  assert.deepEqual([r.status, tries], ['GENERATING PDF', 2]);
  tries = 0;
  t = setup({ meta: { 'dc:title': 'T', fmcStatus: 'FINAL APPROVAL PENDING' }, generate: () => { tries += 1; const e = new Error('HTTP 403'); e.status = 403; throw e; } });
  await assert.rejects(startJob(t.aem, t.sheets, ID, T0, { wait: async () => {} }), (e) => e.status === 403);
  assert.equal(tries, 1);

  // refused or unaccepted requests are errors that say why
  t = setup({ meta: { 'dc:title': 'T', fmcStatus: 'FINAL APPROVAL PENDING' }, generate: () => { const e = new Error('AEM generate -> HTTP 403'); e.status = 403; throw e; } });
  await assert.rejects(startJob(t.aem, t.sheets, ID, T0), (e) => e.status === 403 && /could not start/.test(e.message));
  t = setup({ meta: { 'dc:title': 'T', fmcStatus: 'FINAL APPROVAL PENDING' }, generate: () => ({ success: false }) });
  await assert.rejects(startJob(t.aem, t.sheets, ID, T0), /did not accept/);
  assert.equal(t.m.fmcStatus, 'FINAL APPROVAL PENDING', 'nothing changes when the request is not accepted');
  await assert.rejects(startJob({ async getMetadata() { return null; } }, null, ID), (e) => e.status === 404);

  // not generating: nothing to do; errors are left alone
  t = setup({ meta: { 'dc:title': 'T', fmcStatus: 'DRAFT' } });
  assert.equal((await finishJob(t.aem, t.sheets, t.da, ID, minutes(1))).state, 'skip');
  t = setup({ meta: { 'dc:title': 'T', fmcStatus: 'PDF ERROR', fmcPdfError: 'x' } });
  assert.equal((await finishJob(t.aem, t.sheets, t.da, ID, minutes(30))).state, 'skip');

  // waiting: not reported yet, queued, or still running
  t = setup({});
  assert.equal((await finishJob(t.aem, t.sheets, t.da, ID, minutes(1))).state, 'waiting');
  t = setup({ queued: [{ jobId: JOB }] });
  assert.equal((await finishJob(t.aem, t.sheets, t.da, ID, minutes(5))).state, 'waiting');
  t = setup({ outputs: [job({ outputStatus: 'Running', outputPath: '' })] });
  assert.equal((await finishJob(t.aem, t.sheets, t.da, ID, minutes(5))).state, 'waiting');
  t = setup({ beaconFails: true });
  assert.equal((await finishJob(t.aem, t.sheets, t.da, ID, minutes(1))).state, 'waiting', 'a status call that fails once is just waited out');

  // another job's output is not ours
  t = setup({ outputs: [job({ jobId: 'someone-else' })] });
  assert.equal((await finishJob(t.aem, t.sheets, t.da, ID, minutes(1))).state, 'waiting');

  // done: reads exactly the file Guides names, hosts it, approves, moves to the archive
  t = setup({ outputs: [job()] });
  const done = await finishJob(t.aem, t.sheets, t.da, ID, minutes(2));
  assert.equal(done.state, 'done');
  assert.equal(t.calls.read, OUT);
  assert.equal(t.m.fmcStatus, 'PUBLISHED');
  assert.equal(t.m.fmcPdf, `/pdfs/${ID.toLowerCase()}.pdf`);
  assert.deepEqual(t.calls.pub, [`pdfs/${ID.toLowerCase()}.pdf`]);
  assert.equal(t.calls.changes.at(-1).active.upsert[0].pdf, t.m.fmcPdf, 'it stays on the home list');
  assert.ok(!t.calls.changes.at(-1).archive.upsert, 'nothing is archived by itself');

  // failures show as PDF ERROR with the reason, and the row carries it
  for (const [opts, at, why] of [
    [{ outputs: [job({ errorsExist: true, ditaotLogFile: '/var/dxml/metadata/outputHistory/a/b/logs.txt' })] }, 1, /failed in Guides: The topic reference href="#null" could not be found/],
    [{ outputs: [job({ ditaotFaliure: true })] }, 1, /failed in Guides/],
    [{ outputs: [job({ outputStatus: 'Failed' })] }, 1, /failed in Guides/],
    [{ outputs: [] }, 5, /never reported/],
    [{ outputs: [job({ outputStatus: 'Running', outputPath: '' })] }, 20, /too long/],
    [{ outputs: [job()], bytes: Buffer.from('<html>') }, 3, /not a PDF/],
  ]) {
    t = setup(opts);
    const x = await finishJob(t.aem, t.sheets, t.da, ID, minutes(at));
    assert.equal(x.state, 'failed', JSON.stringify(opts));
    assert.equal(t.m.fmcStatus, 'PDF ERROR');
    assert.match(t.m.fmcPdfError, why);
    assert.match(t.calls.changes.at(-1).active.upsert[0].note, why, 'the reason travels with the row');
    assert.equal(t.calls.put.length, 0);
  }

  // the poller handles every generating communication
  t = setup({ outputs: [job()] });
  const all = await pollAll(t.aem, t.sheets, t.da, minutes(3));
  assert.deepEqual([all.checked, all.results[0].state], [1, 'done']);
  console.log('fmc-pdfjob: ok');
})().catch((e) => { console.error(e); process.exit(1); });
