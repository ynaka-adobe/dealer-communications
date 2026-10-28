/*
 * reconcile — compares every communication in AEM with the two list sheets and repairs drift.
 * The safety net behind the event-driven sync: events can be delayed or missed, and AEM may delete
 * an asset without an event we subscribe to. Runs on an alarm trigger (see README); not a web action.
 */
const { aemClient, sheetStore } = require('../../lib/fmc/runtime');
const { reconcile } = require('../../lib/fmc/sync');

async function main(params) {
  const sheets = await sheetStore(params);
  if (!sheets) return { skipped: 'sheet storage is not configured' };
  const report = await reconcile(await aemClient(), sheets);
  console.log('reconcile', JSON.stringify(report)); // eslint-disable-line no-console
  return report;
}

exports.main = main;
