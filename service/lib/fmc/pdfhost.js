/*
 * Host a finished PDF on the site and publish the communication: the PDF is stored as site
 * content (so it opens in the browser and downloads from the site's own origin) and the topic
 * records its path. The row stays on the home list; archiving is a separate, deliberate step.
 */
const { topicPath, syncSafely } = require('./sync');

const MAX_PDF = 20 * 1024 * 1024;

class PdfError extends Error {}

async function hostAndApprove(aem, sheets, da, { id, bytes, status = 'PUBLISHED' }, now = new Date()) {
  if (bytes.length > MAX_PDF) throw new PdfError('the PDF is larger than 20 MB');
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new PdfError('that is not a PDF');
  const sitePath = `pdfs/${String(id).toLowerCase()}.pdf`;
  await da.putBinary(sitePath, bytes, 'application/pdf');
  await da.publish(sitePath);
  const stamp = now.toISOString().slice(0, 19);
  await aem.setMetadata(topicPath(id), { fmcStatus: status, fmcModified: stamp, fmcPdf: `/${sitePath}` });
  return { id, status, pdf: `/${sitePath}`, bytes: bytes.length, sheet: await syncSafely(aem, sheets, id, now) };
}

module.exports = { hostAndApprove, PdfError, MAX_PDF };
