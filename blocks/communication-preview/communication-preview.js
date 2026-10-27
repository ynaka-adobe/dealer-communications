import { getCommunicationDetail, listCommunications } from '../../scripts/communications-api.js';
import { sanitizeHtml } from '../create-draft/rich-text.js';
import { downloadHtml, openHtml } from '../../scripts/communication-export.js';

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// One look for every action. The PDF is a file on this site, so its actions are links; the HTML
// is built in the page from the communication's content, so its actions are buttons.
function linkButton(label, href, { download = '', newTab = false } = {}) {
  const a = el('a', 'communication-preview-button', label);
  a.href = href;
  if (download) a.setAttribute('download', download);
  if (newTab) { a.target = '_blank'; a.rel = 'noopener'; }
  return a;
}

function actionButton(label, onClick) {
  const b = el('button', 'communication-preview-button', label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** The PDF actions (when there is a PDF) and the HTML actions (when there is content). */
function actionBar({
  file, pdf, hasHtml,
}) {
  const bar = el('div', 'communication-preview-actions');
  if (pdf) {
    bar.append(linkButton('Download PDF', pdf, { download: `${file}.pdf` }), linkButton('Open PDF in new tab', pdf, { newTab: true }));
  }
  if (hasHtml) {
    bar.append(actionButton('Download HTML', () => downloadHtml(file)), actionButton('Open HTML in new tab', () => openHtml(file)));
  }
  return bar;
}

export default async function decorate(block) {
  const file = new URLSearchParams(window.location.search).get('file');
  // a published communication has a PDF exported from AEM Guides, hosted on this site. It may be
  // on the home list or filed in the archive, so look in both.
  const [detail, archived, current] = await Promise.all([
    getCommunicationDetail(file),
    listCommunications('archive').catch(() => []),
    listCommunications('active').catch(() => []),
  ]);
  const entry = [...current, ...archived].find((r) => r.fileName === file || r.id === file);
  const pdf = entry && entry.pdf;
  block.textContent = '';

  const layout = el('div', 'communication-preview-layout');

  const side = el('aside', 'communication-preview-fields');
  const main = el('article', 'communication-preview-body');

  if (pdf) {
    layout.classList.add('has-pdf');
    main.append(el('h1', '', (detail && detail.title) || entry.title));
    const bar = actionBar({ file: entry.fileName, pdf, hasHtml: !!detail });
    const viewer = el('iframe', 'communication-preview-pdf');
    viewer.src = pdf;
    viewer.title = `${entry.title} (PDF)`;
    viewer.loading = 'lazy';
    main.append(bar, viewer);
    const fields = (detail && detail.fields) || [['Status', entry.status], ['Reviewer', entry.reviewer], ['Author', entry.author]];
    fields.forEach(([label, value]) => {
      const dl = el('div', 'communication-preview-field');
      dl.append(el('p', 'communication-preview-label', label), el('p', 'communication-preview-value', value));
      side.append(dl);
    });
  } else if (detail) {
    detail.fields.forEach(([label, value]) => {
      const dl = el('div', 'communication-preview-field');
      dl.append(el('p', 'communication-preview-label', label), el('p', 'communication-preview-value', value));
      side.append(dl);
    });
    main.append(el('h1', '', detail.title));
    main.append(actionBar({ file, pdf: '', hasHtml: true }));
    const content = el('div', 'communication-preview-content');
    content.innerHTML = sanitizeHtml(detail.body); // remote content is not trusted
    main.append(content);
  } else {
    main.append(el('h1', '', file || 'No communication selected'));
    main.append(el('p', '', 'No preview is available for this communication.'));
  }

  const close = el('button', 'communication-preview-close', 'Close');
  close.type = 'button';
  close.addEventListener('click', () => {
    if (document.referrer && new URL(document.referrer).origin === window.location.origin) {
      window.history.back();
    } else {
      window.location.href = '/archive';
    }
  });

  layout.append(side, main);
  block.append(layout, close);
}
