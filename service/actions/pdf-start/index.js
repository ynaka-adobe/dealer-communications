/*
 * pdf-start — the slow half of Approve, run in the background so the site gets its answer at once.
 *
 * Started (not waited for) by the `communications` action after it marks a communication
 * GENERATING PDF: waits for Guides to recognize the map, asks it to generate the PDF, and leaves the
 * rest to `pdf-poll`. If it cannot start the job, the communication goes to PDF ERROR with the
 * reason. Not a web action.
 */
const { aemClient, sheetStore, daClient } = require('../../lib/fmc/runtime');
const { runApproval } = require('../../lib/fmc/review');
const { giveUp, parseStyles } = require('../../lib/fmc/pdfjob');

const real = (v) => typeof v === 'string' && v !== '' && !v.startsWith('$');

async function main(params) {
  const id = String(params.id || '');
  if (!/^DRAFT-\d{14}-[a-z0-9]{4}$/.test(id)) return { skipped: 'invalid id' };
  const aem = await aemClient();
  const sheets = await sheetStore(params);
  const da = daClient(params);
  if (!sheets || !da) return { skipped: 'sheet storage is not configured' };
  try {
    return await runApproval({ id }, {
      aem,
      sheets,
      da,
      host: real(params.DC_PUBLISH_HOST) ? params.DC_PUBLISH_HOST : undefined,
      output: real(params.DC_PDF_OUTPUT) ? params.DC_PDF_OUTPUT : undefined,
      outputParams: real(params.DC_PDF_PARAMS) ? params.DC_PDF_PARAMS : undefined,
      styles: real(params.DC_PDF_STYLES) ? parseStyles(params.DC_PDF_STYLES) : undefined,
    });
  } catch (e) {
    console.error('pdf-start failed', e && e.message); // eslint-disable-line no-console
    return giveUp(aem, sheets, id, (e && e.message) || 'could not start the PDF generation', new Date());
  }
}

exports.main = main;
