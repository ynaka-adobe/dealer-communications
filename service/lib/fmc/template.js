/*
 * The FMCDealer layout for the Dealer Native PDF template: a block of CSS added to the template's
 * content.css that puts the details in a left column, the message in a right column with a rule
 * between them (the site's preview, on paper), and drops the "Chapter 1" label.
 *
 * The block sits between two marker comments, so running the deploy again replaces it instead of
 * stacking copies. The file is uploaded as a new version, so the previous one can be restored in AEM.
 */
const TEMPLATE_CSS = '/content/dam/dita-templates/pdf/Dealer/content.css';
const START = '/* ===== FMCDealer sidebar layout (managed by the service) ===== */';
const END = '/* ===== end FMCDealer sidebar layout ===== */';

const LAYOUT_CSS = `${START}
/* no "Chapter 1" label; the title sits at the top of the message column, level with the details */
h1.chapter:before { content: none; }
h1.chapter {
  float: right;
  box-sizing: border-box;
  width: 71%;
  column-span: none;
  margin: 0;
  padding: 0 3% 8pt 3%;
  border-left: 3pt solid #d9dce6;
  border-right: 3pt solid #d9dce6;
  font-size: 17pt;
  line-height: 1.25;
}

/* the details: a narrow column on the left, starting level with the title */
.section.fmc-sidebar {
  float: left;
  clear: left;
  box-sizing: border-box;
  width: 25%;
  margin: 0;
  padding: 0;
}
.section.fmc-sidebar + .section.fmc-sidebar { margin-top: 16pt; }
.section.fmc-sidebar > .title { display: none; }
.section.fmc-sidebar p { margin: 0; }
.section.fmc-sidebar .fmc-label {
  font-size: 10.5pt;
  font-weight: bold;
  margin-top: 12pt;
  margin-bottom: 3pt;
}
.section.fmc-sidebar .fmc-label:first-of-type { margin-top: 0; }
.section.fmc-sidebar .fmc-value {
  font-size: 10.5pt;
  line-height: 1.4;
}

/* the message: a wide column on the right, with a light rule down each side */
.section:not(.fmc-sidebar) {
  clear: right;
  box-sizing: border-box;
  width: 71%;
  margin: 0 0 0 29%;
  padding: 6pt 3% 6pt 3%;
  border-left: 3pt solid #d9dce6;
  border-right: 3pt solid #d9dce6;
}
.section:not(.fmc-sidebar) > .title { margin-top: 6pt; }
.section:not(.fmc-sidebar) p,
.section:not(.fmc-sidebar) .p,
.section:not(.fmc-sidebar) li { line-height: 1.5; }
.section:not(.fmc-sidebar) p,
.section:not(.fmc-sidebar) .p { margin-bottom: 0.6em; }
${END}`;

/** content.css with the managed block added or replaced. */
function withLayout(css) {
  const base = String(css || '');
  const a = base.indexOf(START);
  const b = base.indexOf(END);
  const cleaned = a !== -1 && b !== -1 && b > a ? `${base.slice(0, a).trimEnd()}\n${base.slice(b + END.length).trimStart()}` : base;
  return `${cleaned.trimEnd()}\n\n${LAYOUT_CSS}\n`;
}

/**
 * The page layout's header is set inline, so it is changed in Common.plt itself: no rule under the
 * header, and the page's top margin makes the room above the logo. (Padding inside the header
 * would only push the logo down into the content, because the header is a fixed-height strip.)
 * Safe to run again.
 */
const COMMON_PLT = '/content/dam/dita-templates/pdf/Dealer/Common.plt';
const TOP_MARGIN = 'margin-top: 64pt;';
const HEADER_EDITS = [
  ['border-collapse: collapse; border-bottom: 2px solid #0a1a5c;"', 'border-collapse: collapse; border-bottom: 0;"'],
  // an earlier version of this change padded the header cells: put them back
  ['padding: 28pt 0 22pt 0; vertical-align: middle;"', 'padding: 0 0 8px 0; vertical-align: middle;"'],
  ['padding: 28pt 0 22pt 12px; vertical-align: middle;', 'padding: 0 0 8px 12px; vertical-align: middle;'],
];

function withHeaderSpacing(plt) {
  let out = String(plt || '');
  HEADER_EDITS.forEach(([from, to]) => { out = out.replace(from, to); });
  const meta = `<meta name="page-style" content="${TOP_MARGIN}" />`;
  if (/<meta name="page-style"[^>]*>/.test(out)) out = out.replace(/<meta name="page-style"[^>]*>/, meta);
  else out = out.replace(/(<title>[^<]*<\/title>)/, `$1\n  ${meta}`);
  return out;
}

/** Add the layout to the template in AEM; resolves with what happened. */
async function deployTemplate(aem, { dryRun = false } = {}) {
  const folder = TEMPLATE_CSS.replace(/\/[^/]+$/, '');
  const result = {};
  const files = [
    [TEMPLATE_CSS, 'content.css', 'text/css', withLayout],
    [COMMON_PLT, 'Common.plt', 'text/html', withHeaderSpacing],
  ];
  for (const [path, name, mime, change] of files) {
    // eslint-disable-next-line no-await-in-loop
    const current = await aem.getText(path);
    if (current == null) throw new Error(`the template file ${name} was not found`);
    const next = change(current);
    result[name] = { changed: next !== current, before: current.length, after: next.length };
    if (next !== current && !dryRun) {
      // eslint-disable-next-line no-await-in-loop
      await aem.uploadText(folder, name, next, mime, { newVersion: true });
    }
  }
  return { changed: Object.values(result).some((r) => r.changed), dryRun: dryRun || undefined, files: result };
}

module.exports = {
  deployTemplate, withLayout, withHeaderSpacing, LAYOUT_CSS, COMMON_PLT, START, END, TEMPLATE_CSS,
};
