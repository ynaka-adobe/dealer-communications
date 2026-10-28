/*
 * pdf-poll — finishes PDF generation for communications that were approved.
 *
 * Runs on a one-minute alarm trigger (see the README): for each communication marked
 * GENERATING PDF it checks the Guides workflow and, once the PDF is Finished, hosts it on the
 * site and moves the communication to the archive. Not a web action.
 */
const { aemClient, sheetStore, daClient } = require('../../lib/fmc/runtime');
const { pollAll } = require('../../lib/fmc/pdfjob');

async function main(params) {
  const sheets = await sheetStore(params);
  const da = daClient(params);
  if (!sheets || !da) return { skipped: 'sheet storage is not configured' };
  return pollAll(await aemClient(), sheets, da);
}

exports.main = main;
