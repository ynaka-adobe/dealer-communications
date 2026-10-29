/*
 * The Adobe look for the Native PDF template: the Adobe template folder (a copy of Dealer made in
 * AEM Assets; never copy a folder through the Assets HTTP API, which emptied the source) with the Adobe
 * wordmark in the header, a red rule under it, and Adobe colours. The details column on the left,
 * the message on the right and the rule between them come from the Dealer layout block already in
 * the copied content.css; only its colours change.
 *
 * Running it again refreshes the three files it owns (Common.plt, content.css, adobe-logo.svg) and
 * leaves the rest of the folder alone.
 */
const FROM = 'Dealer';
const TO = 'Adobe';
const BASE = '/content/dam/dita-templates/pdf';
const RED = '#eb1000';
const INK = '#2c2c2c';
const RULE = '#e1e1e1';
const START = '/* ===== Adobe look (managed by the service) ===== */';
const END = '/* ===== end Adobe look ===== */';

const ADOBE_CSS = `${START}
body { color: ${INK}; }
h1.chapter { color: ${INK}; border-left-color: ${RULE}; border-right-color: ${RULE}; }
.section:not(.fmc-sidebar) { border-left-color: ${RULE}; border-right-color: ${RULE}; }
.section.fmc-sidebar .fmc-label { color: ${RED}; }
a, .xref { color: ${RED}; }
${END}`;

/** Common.plt: wordmark and "Dealer Communications" in red, a red rule under them, a quiet footer. */
function commonPlt() {
  return `<?xml version="1.0" encoding="utf-8" ?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <link rel="stylesheet" href="layout.css" type="text/css" />
  <link rel="stylesheet" href="content.css" type="text/css" />
  <title>Common Page Layout</title>
  <meta name="page-style" content="margin-top: 64pt;" />
</head>
<body data-layout="page"><!-- header: the Adobe wordmark on the left, the site name on the right, a red rule underneath -->
  <div data-region="header">
    <table style="width: 100%; border-collapse: collapse; border-bottom: 2px solid ${RED};">
      <tbody>
        <tr>
          <td style="padding: 0 0 8px 0; vertical-align: middle;"><img alt="Adobe" height="28" src="adobe-logo.svg" width="111" /></td>
          <td style="padding: 0 0 8px 0; vertical-align: middle; text-align: right; font-family: Helvetica, Arial, sans-serif; font-size: 20px; font-weight: 400; color: ${RED};">Dealer Communications</td>
        </tr>
      </tbody>
    </table>
  </div>
  <!-- the communication's content flows here -->
  <div data-region="content"></div>
  <!-- footer: a light rule and the copyright line, centred -->
  <div data-region="footer">
    <div style="text-align: center; border-top: 1px solid ${RULE}; padding-top: 8px; font-family: Helvetica, Arial, sans-serif; font-size: 11px; color: #6e6e6e;">Copyright © 2026 Dealer Communications. All rights reserved.</div>
  </div>
</body>
</html>
`;
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** content.css: the Dealer sheet with its navy and blue-grey swapped for the Adobe colours, plus the look block. */
function adobeCss(dealerCss) {
  const base = String(dealerCss)
    .replace(new RegExp(`\\n?${escapeRe(START)}[\\s\\S]*?${escapeRe(END)}\\n?`), '\n')
    .replace(/#0a1a5c/gi, INK)
    .replace(/#d9dce6/gi, RULE)
    .replace(/#c9cde0/gi, RULE);
  return `${base.trimEnd()}\n\n${ADOBE_CSS}\n`;
}

async function createAdobeTemplate(aem, svg) {
  const dealerCss = await aem.getText(`${BASE}/${FROM}/content.css`);
  if (dealerCss == null) throw new Error('the Dealer template content.css was not found');
  const folder = `${BASE}/${TO}`;
  const again = { newVersion: true };
  await aem.uploadText(folder, 'adobe-logo.svg', svg, 'image/svg+xml', again);
  await aem.uploadText(folder, 'content.css', adobeCss(dealerCss), 'text/css', again);
  await aem.uploadText(folder, 'Common.plt', commonPlt(), 'text/html', again);
  await aem.titleAdobeTemplate('Adobe', 'Adobe look for Dealer Communications PDFs');
  return { folder, files: ['adobe-logo.svg', 'content.css', 'Common.plt'] };
}

/** A logo that is a plain svg: no scripts, no event handlers, small. */
function plainSvg(text) {
  const s = String(text || '');
  return /^\s*<svg[\s>]/.test(s) && s.length <= 20000 && !/<script|on[a-z]+\s*=|<foreignObject/i.test(s);
}

module.exports = {
  createAdobeTemplate, adobeCss, commonPlt, plainSvg, ADOBE_CSS, START, END,
};
