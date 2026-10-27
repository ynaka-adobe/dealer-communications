/*
 * Local stub of the communications service, for trying the site against the real contract
 * (docs/communications-api.md) before any AEM work exists.
 *
 *   node tools/communications-stub/server.mjs   ->  http://localhost:8788/tools/communications-stub/
 *
 * Serves this repo as static files and the API under /api/fmc/communications on the same
 * origin, so the page can run in remote mode. Drafts live in memory and move through the
 * workflow states on a timer so the list can be seen updating. Listens on localhost only.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

// The site's .js files are browser ES modules, but the repo's package.json has no "type":
// "module", so load the (import-free) sample data module from source as an ES module.
const dataSource = await readFile(join(ROOT, 'blocks/communications/communications-data.js'), 'utf8');
const { default: getCommunications, getCommunicationDetail } = await import(`data:text/javascript;base64,${Buffer.from(dataSource).toString('base64')}`);
const PORT = Number(process.env.PORT) || 8788;
const MAX_BODY = 256 * 1024;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// demo clock: seconds since creation -> status
const STAGES = [[15, 'DRAFT'], [30, 'REVIEWER PENDING'], [45, 'FINAL APPROVAL PENDING'], [Infinity, 'PUBLISHED']];
const statusFor = (createdMs) => STAGES.find(([limit]) => (Date.now() - createdMs) / 1000 < limit)[1];

const drafts = [];
const savedSteps = new Map(); // draft id -> { state }
let counter = 90;
const iso = (ms) => new Date(ms).toISOString().slice(0, 19);

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
};
const sendJson = (res, status, data) => send(res, status, JSON.stringify(data), { 'content-type': 'application/json' });

function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { fail(new Error('too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

const row = (d) => ({
  id: d.id,
  fileName: d.fileName,
  title: d.title,
  status: statusFor(d.createdMs),
  reviewer: d.reviewer,
  author: d.author,
  created: iso(d.createdMs),
  modified: iso(Math.max(d.createdMs, Date.now() - ((Date.now() - d.createdMs) % 15000))),
});

// the two list sheets, in the same shape DA publishes them (every cell a string)
const sheetRow = (r, i) => {
  const id = r.id || r.fileName || `SAMPLE-${i + 1}`;
  return {
    id, fileName: r.fileName || id, title: r.title, status: r.status, reviewer: r.reviewer || '-', author: r.author || '-',
    created: r.created || '', modified: r.modified || r.created || '', locked: String(!!r.locked), aemPath: '',
  };
};
const sheetJson = (rows) => JSON.stringify({
  total: rows.length, limit: rows.length, offset: 0, data: rows, ':sheetname': 'data', ':type': 'sheet',
});

async function dataSheet(res, name) {
  if (name === 'archive') return send(res, 200, sheetJson((await getCommunications('archive')).map(sheetRow)), { 'content-type': 'application/json' });
  const rows = [...drafts.map(row), ...await getCommunications()].map(sheetRow);
  return send(res, 200, sheetJson(rows), { 'content-type': 'application/json' });
}

async function api(req, res, url) {
  const parts = url.pathname.replace(/^\/api\/fmc\/(communications\/?)?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (req.method === 'PUT' && parts[0] === 'drafts' && parts.length === 2) {
    if (!/^DRAFT-\d{14}-[a-z0-9]{4}$/.test(parts[1])) return sendJson(res, 400, { error: 'invalid draft id' });
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: 'invalid json' }); }
    savedSteps.set(parts[1], { state: payload });
    let d = drafts.find((x) => x.id === parts[1]);
    if (!d) {
      d = { id: parts[1], fileName: parts[1], createdMs: Date.now() };
      drafts.push(d);
    }
    d.title = String((payload && payload.title) || 'Untitled draft').slice(0, 250);
    d.reviewer = String((payload && payload.reviewer) || '-').slice(0, 64);
    d.author = String((payload && payload.originator) || '-').slice(0, 64);
    console.log(`step saved for ${parts[1]} (title: ${d.title})`);
    return sendJson(res, 200, { id: parts[1], saved: true });
  }
  if (req.method === 'GET' && parts.length === 0) {
    const type = url.searchParams.get('type') === 'archive' ? 'archive' : 'active';
    if (type === 'archive') return sendJson(res, 200, await getCommunications('archive'));
    return sendJson(res, 200, [...drafts.map(row).reverse(), ...await getCommunications()]);
  }
  if (req.method === 'POST' && parts.length === 0) {
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: 'invalid json' }); }
    if (!payload || typeof payload.title !== 'string' || !payload.title.trim()) return sendJson(res, 422, { error: 'title is required' });
    // a draft saved step by step is submitted under the same id; anything else gets a new one
    const wanted = typeof payload.draftId === 'string' && /^DRAFT-\d{14}-[a-z0-9]{4}$/.test(payload.draftId) ? payload.draftId : '';
    let d = wanted && drafts.find((x) => x.id === wanted);
    if (!d) {
      counter += 1;
      d = { id: wanted || `draft-${counter}`, fileName: wanted || `EFC2600${counter}`, createdMs: Date.now() };
      drafts.push(d);
    }
    d.title = payload.title.trim().slice(0, 250);
    d.reviewer = String(payload.reviewer || '-').slice(0, 64);
    d.author = String(payload.originator || '-').slice(0, 64);
    return sendJson(res, 201, { id: d.id, fileName: d.fileName, status: 'DRAFT' });
  }
  if (req.method === 'GET' && parts.length === 2 && parts[1] === 'status') {
    const d = drafts.find((x) => x.id === parts[0]);
    return d ? sendJson(res, 200, { id: d.id, status: statusFor(d.createdMs), updated: row(d).modified }) : sendJson(res, 404, { error: 'not found' });
  }
  if (req.method === 'GET' && parts.length === 1) {
    const detail = await getCommunicationDetail(parts[0]);
    return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: 'not found' });
  }
  return sendJson(res, 404, { error: 'not found' });
}

async function serveStatic(res, pathname) {
  const target = normalize(join(ROOT, decodeURIComponent(pathname === '/' ? '/tools/communications-stub/index.html' : pathname.replace(/\/$/, '/index.html'))));
  if (!target.startsWith(ROOT) || /\/\.|node_modules/.test(target.slice(ROOT.length))) return send(res, 403, 'Forbidden');
  try {
    return send(res, 200, await readFile(target), { 'content-type': TYPES[extname(target)] || 'application/octet-stream' });
  } catch (e) {
    return send(res, 404, 'Not found');
  }
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/fmc/')) return await api(req, res, url);
    const sheet = /^\/data\/(notifications|archive)\.json$/.exec(url.pathname);
    if (sheet) return await dataSheet(res, sheet[1]);
    return await serveStatic(res, url.pathname);
  } catch (e) {
    return sendJson(res, 500, { error: 'server error' });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`communications stub on http://localhost:${PORT}/ (static + /api/fmc/communications)`));
