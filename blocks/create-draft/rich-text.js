/*
 * Small rich-text editor (contenteditable + toolbar) and an allow-list HTML sanitizer.
 * document.execCommand is deprecated but is still the simplest dependency-free option
 * for a demo; swap in a real editor if this graduates beyond one.
 */
const ALLOWED_TAGS = new Set([
  'P', 'BR', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'S', 'STRIKE', 'U', 'UL', 'OL', 'LI', 'A',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4',
]);
const COLOR = /^(#[0-9a-f]{3,8}|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)|[a-z]+)$/i;

function cleanNode(node, doc) {
  if (node.nodeType === Node.TEXT_NODE) return doc.createTextNode(node.textContent);
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const tag = node.tagName;
  if (!ALLOWED_TAGS.has(tag)) {
    // drop the element, keep its (cleaned) children, unless it is script-like
    if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED'].includes(tag)) return null;
    const frag = doc.createDocumentFragment();
    node.childNodes.forEach((c) => { const n = cleanNode(c, doc); if (n) frag.append(n); });
    return frag;
  }
  const out = doc.createElement(tag.toLowerCase());
  if (tag === 'A') {
    const href = node.getAttribute('href') || '';
    if (/^(https?:|mailto:|\/)/i.test(href)) {
      out.setAttribute('href', href);
      out.setAttribute('rel', 'noopener noreferrer');
    }
  }
  const style = node.getAttribute('style') || '';
  const keep = [];
  style.split(';').forEach((decl) => {
    const [prop, ...rest] = decl.split(':');
    const name = (prop || '').trim().toLowerCase();
    const value = rest.join(':').trim();
    if (['color', 'background-color'].includes(name) && COLOR.test(value)) keep.push(`${name}: ${value}`);
    if (name === 'text-align' && /^(left|right|center|justify)$/i.test(value)) keep.push(`${name}: ${value}`);
  });
  if (keep.length) out.setAttribute('style', keep.join('; '));
  node.childNodes.forEach((c) => { const n = cleanNode(c, doc); if (n) out.append(n); });
  return out;
}

export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  const holder = document.createElement('div');
  doc.body.childNodes.forEach((c) => { const n = cleanNode(c, document); if (n) holder.append(n); });
  return holder.innerHTML;
}

const TOOLS = [
  ['undo', '↶', 'Undo'], ['redo', '↷', 'Redo'], null,
  ['bold', 'B', 'Bold'], ['italic', 'I', 'Italic'], ['strikeThrough', 'S', 'Strikethrough'], null,
  ['color', 'A', 'Text color'], ['hilite', '✎', 'Highlight'], null,
  ['justifyLeft', '≡', 'Align left'], ['justifyCenter', '≡', 'Align center'],
  ['justifyRight', '≡', 'Align right'], ['justifyFull', '≡', 'Justify'], null,
  ['insertOrderedList', '1.', 'Numbered list'], ['insertUnorderedList', '•', 'Bulleted list'], null,
  ['link', '\u{1F517}', 'Link'], ['table', '▦', 'Insert table'], ['removeFormat', 'Tx', 'Clear formatting'],
];

export function richText(state, key, label, { required } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'cd-field cd-rich';
  wrap.dataset.required = required ? 'true' : 'false';

  const l = document.createElement('p');
  l.className = 'cd-label';
  if (required) {
    const star = document.createElement('span');
    star.className = 'cd-req';
    star.textContent = '*';
    l.append(star);
  }
  l.append(label);

  const bar = document.createElement('div');
  bar.className = 'cd-toolbar';
  bar.setAttribute('role', 'toolbar');
  const area = document.createElement('div');
  area.className = 'cd-editor';
  area.contentEditable = 'true';
  area.setAttribute('role', 'textbox');
  area.setAttribute('aria-multiline', 'true');
  area.setAttribute('aria-label', label);
  area.innerHTML = sanitizeHtml(state[key]);
  area.addEventListener('input', () => { state[key] = sanitizeHtml(area.innerHTML); });

  const exec = (cmd, value) => { area.focus(); document.execCommand(cmd, false, value); state[key] = sanitizeHtml(area.innerHTML); };

  TOOLS.forEach((t) => {
    if (!t) {
      const sep = document.createElement('span');
      sep.className = 'cd-sep';
      bar.append(sep);
      return;
    }
    const [cmd, glyph, title] = t;
    if (cmd === 'color' || cmd === 'hilite') {
      const c = document.createElement('input');
      c.type = 'color';
      c.title = title;
      c.setAttribute('aria-label', title);
      c.className = `cd-color cd-color-${cmd}`;
      c.value = cmd === 'color' ? '#000000' : '#ffff00';
      c.addEventListener('input', () => exec(cmd === 'color' ? 'foreColor' : 'hiliteColor', c.value));
      bar.append(c);
      return;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.textContent = glyph;
    b.className = `cd-tool cd-tool-${cmd}`;
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
    b.addEventListener('click', () => {
      if (cmd === 'link') {
        const url = window.prompt('Link URL (https://…)');
        if (url && /^(https?:|mailto:)/i.test(url)) exec('createLink', url);
      } else if (cmd === 'table') {
        exec('insertHTML', '<table><tbody><tr><td>&nbsp;</td><td>&nbsp;</td></tr><tr><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table><p><br></p>');
      } else {
        exec(cmd);
      }
    });
    bar.append(b);
  });

  const err = document.createElement('p');
  err.className = 'cd-error';
  wrap.append(l, bar, area, err);
  return wrap;
}
