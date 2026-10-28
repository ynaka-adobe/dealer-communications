/*
 * admin — operator operations for the communications service (not a web action).
 *
 *   aio rt action invoke dealer-communications/admin -b -r -p op set-status -p id <id> -p status "REVIEWER PENDING"
 *   aio rt action invoke dealer-communications/admin -b -r -p op sync -p id <id>
 *   aio rt action invoke dealer-communications/admin -b -r -p op reconcile
 *   aio rt action invoke dealer-communications/admin -b -r -p op add-map -p id <id>        (one communication)
 *   aio rt action invoke dealer-communications/admin -b -r -p op delete -p id <id> -p confirm yes   (AEM folder, rows, draft, PDF)
 *   aio rt action invoke dealer-communications/admin -b -r -p op setup-guides              (DITAVAL filters, once)
 *   aio rt action invoke dealer-communications/admin -b -r -p op attach-pdf -p id <id> -p url <https AEM publish PDF url>
 */
const { aemClient, sheetStore, daClient } = require('../../lib/fmc/runtime');
const { run, AdminError } = require('../../lib/fmc/admin');

async function main(params) {
  try {
    return await run(params, await aemClient(), await sheetStore(params), new Date(), daClient(params));
  } catch (err) {
    if (err instanceof AdminError) return { error: err.message };
    throw err;
  }
}

exports.main = main;
