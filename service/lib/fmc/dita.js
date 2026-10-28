/*
 * Converts a Create Draft payload into a DITA topic (for AEM Guides) and a matching
 * HTML preview, from one parsed structure.
 *
 * Rich text arrives as HTML from the browser, which is NOT trusted: it is tokenized
 * here and only an allow-listed set of constructs is re-emitted, with every text node
 * escaped, so the output is well-formed and cannot carry markup the caller invented.
 *
 * Audience: field-only content is written as <section audience="field"> and the dealer
 * sections as audience="dealer", so Guides can produce a field and a dealer output from
 * the one topic with a DITAVAL filter.
 */

const VOID = new Set(['br', 'hr']);
const SKIP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'head']);
const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'table', 'tbody', 'thead', 'tr']);

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// strip characters that are illegal in XML 1.0
const clean = (v) => String(v == null ? '' : v).replace(/[^\u0009\u000A\u000D -퟿-�]/g, '');

const decode = (t) => t
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** HTML string -> tree of { tag, attrs, children } and { text }. */
function parse(html) {
  const root = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g;
  let m;
  let skipping = null;
  const src = String(html || '').slice(0, 200000);
  while ((m = re.exec(src))) {
    if (m[3] !== undefined) {
      if (!skipping) stack[stack.length - 1].children.push({ text: decode(m[3]) });
    } else if (m[1]) {
      const tag = m[1].toLowerCase();
      const closing = m[0][1] === '/';
      if (skipping) {
        if (closing && tag === skipping) skipping = null;
      } else if (closing) {
        for (let i = stack.length - 1; i > 0; i -= 1) {
          if (stack[i].tag === tag) { stack.length = i; break; }
        }
      } else if (SKIP.has(tag)) {
        skipping = tag;
      } else {
        const attrs = {};
        const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m[2] || '');
        if (href) attrs.href = decode(href[2] !== undefined ? href[2] : href[3]);
        const node = { tag, attrs, children: [] };
        stack[stack.length - 1].children.push(node);
        if (!VOID.has(tag) && !/\/\s*$/.test(m[2] || '')) stack.push(node);
      }
    }
  }
  return root;
}

const safeHref = (h) => (/^(https?:\/\/|mailto:)/i.test(h || '') ? h : '');

/** Inline nodes -> { dita, html } strings. */
function inline(nodes) {
  let dita = '';
  let html = '';
  nodes.forEach((n) => {
    if (n.text !== undefined) {
      const t = clean(n.text).replace(/\s+/g, ' ');
      dita += esc(t);
      html += esc(t);
      return;
    }
    const inner = inline(n.children);
    const wrap = (d, h) => { dita += `<${d}>${inner.dita}</${d}>`; html += `<${h}>${inner.html}</${h}>`; };
    switch (n.tag) {
      case 'b': case 'strong': wrap('b', 'strong'); break;
      case 'i': case 'em': wrap('i', 'em'); break;
      case 'u': wrap('u', 'u'); break;
      case 'br': dita += ' '; html += '<br>'; break;
      case 'a': {
        const href = safeHref(n.attrs.href);
        if (href) {
          dita += `<xref href="${esc(href)}" scope="external" format="html">${inner.dita}</xref>`;
          html += `<a href="${esc(href)}" rel="noopener noreferrer">${inner.html}</a>`;
        } else { dita += inner.dita; html += inner.html; }
        break;
      }
      default: dita += inner.dita; html += inner.html;
    }
  });
  return { dita, html };
}

/** Block-level nodes -> { dita, html }. Loose inline runs become paragraphs. */
function blocks(nodes) {
  let dita = '';
  let html = '';
  let run = [];
  const flush = () => {
    const i = inline(run);
    if (i.dita.trim()) { dita += `<p>${i.dita.trim()}</p>`; html += `<p>${i.html.trim()}</p>`; }
    run = [];
  };
  nodes.forEach((n) => {
    if (n.text !== undefined || !BLOCK.has(n.tag)) { run.push(n); return; }
    flush();
    if (n.tag === 'ul' || n.tag === 'ol') {
      const items = n.children.filter((c) => c.tag === 'li').map((li) => blocks(li.children));
      if (!items.length) return;
      dita += `<${n.tag}>${items.map((i) => `<li>${i.dita || '<p/>'}</li>`).join('')}</${n.tag}>`;
      html += `<${n.tag}>${items.map((i) => `<li>${i.html}</li>`).join('')}</${n.tag}>`;
    } else if (n.tag === 'table') {
      const rows = [];
      const walk = (kids) => kids.forEach((c) => {
        if (c.tag === 'tr') rows.push(c.children.filter((x) => x.tag === 'td' || x.tag === 'th').map((x) => inline(x.children)));
        else if (c.children) walk(c.children);
      });
      walk(n.children);
      if (!rows.length) return;
      dita += `<simpletable>${rows.map((r) => `<strow>${r.map((c) => `<stentry>${c.dita.trim()}</stentry>`).join('')}</strow>`).join('')}</simpletable>`;
      html += `<table><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c.html.trim()}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    } else if (/^h[1-4]$/.test(n.tag)) {
      const i = inline(n.children);
      if (i.dita.trim()) { dita += `<p><b>${i.dita.trim()}</b></p>`; html += `<p><strong>${i.html.trim()}</strong></p>`; }
    } else if (n.tag === 'li' || n.tag === 'tr' || n.tag === 'tbody' || n.tag === 'thead') {
      const b = blocks(n.children); dita += b.dita; html += b.html;
    } else {
      const b = blocks(n.children); dita += b.dita; html += b.html; // p, div
    }
  });
  flush();
  return { dita, html };
}

/** Untrusted HTML -> { dita, html } fragments. */
function convertRichText(html) {
  return blocks(parse(html).children);
}

/** Plain text of a rich-text fragment (for length checks). */
function plainText(html) {
  return decode(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const SECTION_ID = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';

const LONG_DATE = new Intl.DateTimeFormat('en-US', {
  month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});

/** A date as the site shows it ("May 5, 2026"); the value is a local date or date-time string. */
function longDate(value, plusDays = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m) return '';
  return LONG_DATE.format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + plusDays)));
}

/**
 * The details that sit beside the message in the PDF: what the site's preview shows in its side
 * panel. Field details are for the field audience and dealer details for dealers, so a DITAVAL
 * that filters by audience leaves each audience only its own. Layout is the template's job
 * (the fmc-sidebar class); here they are plain label and value paragraphs.
 */
function sidebarSections(d) {
  const val = (v) => esc(clean(Array.isArray(v) ? v.filter(Boolean).join(', ') : v)) || '\u2014';
  const rows = (list) => list.map(([k, v]) => `<p outputclass="fmc-label">${esc(k)}</p><p outputclass="fmc-value">${val(v)}</p>`).join('');
  const out = [`<section id="fmc-field-details" audience="field" outputclass="fmc-sidebar"><title>Field details</title>${rows([
    ['Field Publish Date', longDate(d.fieldPublish)],
    ['Target Field Group', d.fieldGroup],
    ['Field Lead', d.fieldLead],
    ['Field Support', d.fieldSupport],
  ])}</section>`];
  if (d.dealerComm) {
    out.push(`<section id="fmc-dealer-details" audience="dealer" outputclass="fmc-sidebar"><title>Dealer details</title>${rows([
      ['Dealer Publish Date', longDate(d.fieldPublish, 1)],
      ['Target Group', d.dealerGroup],
      ['Target Roles', d.dealerRoles],
      ['Target Department', [d.primaryDept, ...(d.additionalDepts || [])]],
    ])}</section>`);
  }
  return out;
}

/**
 * Build the topic and the HTML preview.
 * @param {object} d validated draft (see lib/fmc/communications.js)
 */
function buildDocuments(d) {
  const sections = [];
  if (d.fieldOnly && plainText(d.fieldOnly)) sections.push({ title: 'Field only information', audience: 'field', html: d.fieldOnly });
  if (d.dealerComm) {
    sections.push({ title: 'Action requested', audience: 'dealer', html: d.action });
    sections.push({ title: 'Summary', audience: 'dealer', html: d.summary });
    (d.extraSections || []).forEach((x) => sections.push({ title: x.title || 'Additional section', audience: 'dealer', html: x.html }));
    sections.push({ title: 'Questions', audience: 'dealer', html: d.questions });
  }

  const meta = Object.entries(d.metadata).filter(([, v]) => v !== '' && v != null);
  const ditaSections = [];
  const htmlSections = [];
  const used = new Set();
  sections.forEach((s) => {
    const c = convertRichText(s.html);
    let id = SECTION_ID(s.title);
    for (let n = 2; used.has(id); n += 1) id = `${SECTION_ID(s.title)}-${n}`;
    used.add(id);
    ditaSections.push(`<section id="${esc(id)}" audience="${s.audience}"><title>${esc(clean(s.title))}</title>${c.dita}</section>`);
    htmlSections.push(`<section data-audience="${s.audience}"><h2>${esc(clean(s.title))}</h2>${c.html}</section>`);
  });

  const topicId = SECTION_ID(d.fileName);
  const dita = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">
<topic id="${esc(topicId)}" xml:lang="en-US">
<title>${esc(clean(d.title))}</title>
<prolog><metadata>${meta.map(([k, v]) => `<othermeta name="${esc(k)}" content="${esc(clean(Array.isArray(v) ? v.join(', ') : v))}"/>`).join('')}</metadata></prolog>
<body>${[...sidebarSections(d), ...ditaSections].join('')}</body>
</topic>
`;
  const preview = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(clean(d.title))}</title></head>
<body><article><h1>${esc(clean(d.title))}</h1>${htmlSections.join('')}</article></body></html>
`;
  return { dita, preview };
}

/**
 * The DITA map for one communication: a single topicref to its topic, by relative name, so the
 * map must be uploaded to the same folder as the topic. AEM Guides builds PDF/HTML from a map.
 */
function buildMap(fileName, title) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE map PUBLIC "-//OASIS//DTD DITA Map//EN" "map.dtd">
<map id="${esc(fileName)}">
  <title>${esc(clean(title))}</title>
  <topicref href="${esc(fileName)}.dita"/>
</map>
`;
}

module.exports = {
  buildMap, buildDocuments, sidebarSections, longDate, convertRichText, plainText, esc, clean };
