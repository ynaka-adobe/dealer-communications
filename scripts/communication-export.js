/*
 * Downloads for a communication. The PDF is a file hosted on this site (a link to it is all that
 * is needed); the HTML is built here from the communication's content as a standalone page.
 */
import { getCommunicationDetail } from './communications-api.js';
import { sanitizeHtml } from '../blocks/create-draft/rich-text.js';

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STYLE = 'body{font:16px/1.5 Arial,Helvetica,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#00095b}'
  + 'h1{font-size:1.6rem}dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:0 0 1.5rem}'
  + 'dt{font-weight:700}dd{margin:0}img{max-width:100%}';

/** A complete, self-contained HTML document for a communication. */
export function buildHtml(detail) {
  const fields = (detail.fields || []).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  return `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>${esc(detail.title)}</title>`
    + `<style>${STYLE}</style></head><body><h1>${esc(detail.title)}</h1>`
    + `${fields ? `<dl>${fields}</dl>` : ''}${sanitizeHtml(detail.body || '')}</body></html>\n`;
}

function save(href, name) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
}

/** Download a communication as an HTML file; resolves false when it has no content. */
export async function downloadHtml(file) {
  const detail = await getCommunicationDetail(file);
  if (!detail) return false;
  const url = URL.createObjectURL(new Blob([buildHtml(detail)], { type: 'text/html' }));
  save(url, `${file}.html`);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}

/**
 * Show a communication's HTML in a new tab. The tab is opened first, inside the click, so a
 * popup blocker allows it, and is pointed at the page once the content has loaded.
 */
export async function openHtml(file) {
  const tab = window.open('', '_blank');
  const detail = await getCommunicationDetail(file);
  if (!detail || !tab) { if (tab) tab.close(); return false; }
  const url = URL.createObjectURL(new Blob([buildHtml(detail)], { type: 'text/html' }));
  tab.opener = null;
  tab.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

export function downloadPdf(path, file) {
  save(path, `${file}.pdf`);
}
