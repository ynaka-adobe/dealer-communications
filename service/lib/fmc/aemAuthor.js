/*
 * AEM Author client for the communications service, behind the `aem` interface that
 * lib/fmc/communications.js expects. Uses the Assets HTTP API for folders and metadata,
 * Direct Binary Upload for files, and Query Builder for listing.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const DirectBinary = require('@adobe/aem-upload');
const { normalizeHost, validateFolder } = require('../aemDirectUpload');
const { assetApiUrl } = require('../aem');

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
const relative = (damPath) => damPath.replace(/^\/content\/dam\//, '');

function createAemClient({ host, token, sdk = DirectBinary, tmpdir = os.tmpdir() }) {
  const origin = normalizeHost(host);
  const auth = { Authorization: `Bearer ${token}` };

  const fail = (what, status) => {
    const e = new Error(`AEM ${what} -> HTTP ${status}`);
    e.status = status;
    return e;
  };

  return {
    async ensureFolder(folderPath, title) {
      validateFolder(folderPath);
      const res = await fetch(`${origin}/api/assets/${encodePath(relative(folderPath))}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ class: 'assetFolder', properties: { title: String(title || '').slice(0, 250) } }),
      });
      if (!res.ok && res.status !== 409) throw fail(`create folder ${folderPath}`, res.status);
    },

    /** Delete a communication's folder (and everything in it); a missing folder is not an error. */
    async deleteFolder(folderPath) {
      validateFolder(folderPath);
      const res = await fetch(`${origin}/api/assets/${encodePath(relative(folderPath))}`, { method: 'DELETE', headers: auth });
      if (!res.ok && res.status !== 404) throw fail(`delete ${folderPath}`, res.status);
      return res.status !== 404;
    },

    /** Start a workflow on a repository path; resolves with the instance path to poll. */
    async startWorkflow(model, payload) {
      validateFolder(path.posix.dirname(payload));
      if (!/^\/var\/workflow\/models\/[A-Za-z0-9_-]+$/.test(model)) throw new Error('invalid workflow model');
      const res = await fetch(`${origin}/var/workflow/instances`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ model, payloadType: 'JCR_PATH', payload }),
        redirect: 'manual',
      });
      if (res.status >= 400 || res.status === 0) throw fail(`start workflow ${model}`, res.status);
      const where = (res.headers.get('location') || '').replace(origin, '');
      if (!/^\/var\/workflow\/instances\/[A-Za-z0-9_/.-]+$/.test(where)) throw new Error('AEM did not say where the workflow instance is');
      return where;
    },

    /** RUNNING, COMPLETED, SUSPENDED, ABORTED ... or null when the instance is gone. */
    async workflowState(instancePath) {
      if (!/^\/var\/workflow\/instances\/[A-Za-z0-9_/.-]+$/.test(instancePath) || instancePath.includes('..')) throw new Error('invalid workflow instance');
      const res = await fetch(`${origin}${encodePath(instancePath)}.json`, { headers: { ...auth, Accept: 'application/json' } });
      if (res.status === 404) return null;
      if (!res.ok) throw fail(`read workflow ${instancePath}`, res.status);
      return (await res.json()).state || null;
    },

    /** The instance as AEM reports it (for diagnosing a run); read only. */
    async workflowInfo(instancePath, depth = 3) {
      if (!/^\/var\/workflow\/instances\/[A-Za-z0-9_/.-]+$/.test(instancePath) || instancePath.includes('..')) throw new Error('invalid workflow instance');
      const res = await fetch(`${origin}${encodePath(instancePath)}.${Math.min(Number(depth) || 1, 5)}.json`, { headers: { ...auth, Accept: 'application/json' } });
      if (!res.ok) throw fail(`read workflow ${instancePath}`, res.status);
      return res.json();
    },

    /**
     * Ask Guides to generate one output of a map: the call behind the Generate button.
     * Resolves with what AEM answered; generation itself runs on in AEM.
     */
    async generateOutput(mapPath, outputName = 'pdf', extra = {}) {
      validateFolder(path.posix.dirname(mapPath));
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(outputName)) throw new Error('invalid output name');
      const qs = new URLSearchParams({
        operation: 'GENERATEOUTPUT', source: mapPath, outputName, cache: 'false',
      });
      // what the Native PDF preset needs besides its name (the Generate button sends them too)
      Object.entries(extra).forEach(([k, v]) => {
        if (['nodejs', 'templatePath', 'cache'].includes(k) && /^[A-Za-z0-9/_.:-]{1,200}$/.test(String(v))) qs.set(k, String(v));
      });
      const res = await fetch(`${origin}/bin/publishlistener?${qs}`, { headers: { ...auth, Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest' } });
      const text = await res.text();
      if (!res.ok) { const e = fail(`generate ${outputName} for ${mapPath}`, res.status); e.body = text.slice(0, 300); throw e; }
      let answer;
      try { answer = JSON.parse(text); } catch (e) { answer = null; }
      return { status: res.status, body: text.slice(0, 500), generationId: answer && answer[outputName] && answer[outputName].generationId, success: !!(answer && answer[outputName] && answer[outputName].success) };
    },

    /** The text of a Guides output log (read only; only the output-history folder). */
    async getOutputLog(logPath) {
      if (!/^\/var\/dxml\/metadata\/outputHistory\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+\/logs\.txt$/.test(logPath)) throw new Error('not an output log');
      const res = await fetch(`${origin}${logPath}`, { headers: auth });
      if (!res.ok) throw fail(`read log ${logPath}`, res.status);
      return res.text();
    },

    /** What Guides reports about the generation of a map's outputs (the page's own status poll). */
    async publishBeacon(mapPath) {
      validateFolder(path.posix.dirname(mapPath));
      const qs = new URLSearchParams({ operation: 'PUBLISHBEACON', source: mapPath, _: String(Date.now()) });
      const res = await fetch(`${origin}/bin/publishlistener?${qs}`, { headers: { ...auth, Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest' } });
      const text = await res.text();
      if (!res.ok) throw fail(`beacon ${mapPath}`, res.status);
      try { return JSON.parse(text); } catch (e) { return { raw: text.slice(0, 800) }; }
    },

    /** The output presets saved on a map (Guides REST servlet; read only). */
    async getPresets(mapPath) {
      validateFolder(path.posix.dirname(mapPath));
      const res = await fetch(`${origin}/bin/guides/presets?${new URLSearchParams({ mapPath })}`, { headers: { ...auth, Accept: 'application/json' } });
      const text = await res.text();
      if (!res.ok) { const e = fail(`read presets ${mapPath}`, res.status); e.body = text.slice(0, 300); throw e; }
      try { return JSON.parse(text); } catch (e) { return { raw: text.slice(0, 2000) }; }
    },

    /**
     * Save an output preset on a map through the Guides servlet. The request format is not
     * documented, so `variant` picks one of the plausible shapes; the caller reads the presets
     * back to see whether it was accepted.
     */
    async postPreset(mapPath, preset, variant) {
      validateFolder(path.posix.dirname(mapPath));
      const head = { ...auth, Accept: 'application/json' };
      const json = { ...head, 'Content-Type': 'application/json' };
      let url = `${origin}/bin/guides/presets`;
      let init;
      if (variant === 'query-json') { url += `?${new URLSearchParams({ mapPath })}`; init = { headers: json, body: JSON.stringify(preset) }; }
      else if (variant === 'wrapped') init = { headers: json, body: JSON.stringify({ mapPath, preset }) };
      else if (variant === 'flat') init = { headers: json, body: JSON.stringify({ mapPath, ...preset }) };
      else if (variant === 'form') init = { headers: { ...head, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ mapPath, preset: JSON.stringify(preset) }) };
      else throw new Error('unknown variant');
      const res = await fetch(url, { method: 'POST', ...init });
      return { status: res.status, body: (await res.text()).slice(0, 300) };
    },

    /**
     * Write one output preset node on a map: scalar properties with explicit types.
     * Only `.../<map>.ditamap/jcr:content/metadata/namedoutputs/<name>` can be written here.
     */
    async writePresetNode(nodePath, props) {
      if (!/^\/content\/dam\/dealer-communications\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.ditamap\/jcr:content\/metadata\/namedoutputs\/[a-z0-9-]+$/.test(nodePath)) throw new Error('not a preset node path');
      const body = new URLSearchParams({ _charset_: 'utf-8', 'jcr:primaryType': 'nt:unstructured' });
      Object.entries(props).forEach(([k, v]) => {
        if (v == null || typeof v === 'object') return; // arrays and objects are left out
        body.set(k, String(v));
        if (typeof v === 'boolean') body.set(`${k}@TypeHint`, 'Boolean');
        else if (typeof v === 'number') body.set(`${k}@TypeHint`, Number.isInteger(v) ? 'Long' : 'Double');
      });
      const res = await fetch(`${origin}${encodePath(nodePath)}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      if (!res.ok) throw fail(`write preset ${nodePath}`, res.status);
    },

    /** The children of a template folder, from the Assets API (read only). */
    async listTemplates(folderPath) {
      if (!/^\/content\/dam\/dita-templates(\/[A-Za-z0-9_. -]+)*$/.test(folderPath) || folderPath.includes('..')) throw new Error('not a template folder');
      const res = await fetch(`${origin}/api/assets/${encodePath(relative(folderPath))}.json`, { headers: { ...auth, Accept: 'application/json' } });
      if (!res.ok) throw fail(`list ${folderPath}`, res.status);
      const body = await res.json();
      return (body.entities || []).map((e) => ({ name: (e.properties && e.properties.name) || '', class: (e.class || []).join(','), type: e.properties && (e.properties['dc:format'] || e.properties['jcr:primaryType']) }));
    },

    /** One repository node as JSON (read only; communications folders and the Guides output folder). */
    async readNode(nodePath, depth = 1) {
      if (!/^\/content\/dam\/(dealer-communications|fmdita-outputs)\/[A-Za-z0-9_:./-]+$/.test(nodePath) || nodePath.includes('..')) throw new Error('path not allowed');
      const res = await fetch(`${origin}${encodePath(nodePath)}.${Math.min(Number(depth) || 1, 3)}.json`, { headers: { ...auth, Accept: 'application/json' } });
      if (!res.ok) throw fail(`read ${nodePath}`, res.status);
      return res.json();
    },

    /** Generated PDFs whose name contains the id, newest first: [{ path, modified, status }]. */
    async findPdfs(id) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new Error('invalid id');
      const qs = new URLSearchParams({
        path: '/content/dam/fmdita-outputs/pdfs',
        type: 'dam:Asset',
        nodename: `*${id}*.pdf`,
        'p.hits': 'selective',
        'p.properties': 'jcr:path jcr:content/jcr:lastModified jcr:content/metadata/status',
        'p.limit': '5',
        orderby: '@jcr:content/jcr:lastModified',
        'orderby.sort': 'desc',
      });
      const res = await fetch(`${origin}/bin/querybuilder.json?${qs}`, { headers: auth });
      if (!res.ok) throw fail('find pdfs', res.status);
      return ((await res.json()).hits || []).map((h) => ({
        path: h['jcr:path'],
        modified: h['jcr:content'] && h['jcr:content']['jcr:lastModified'],
        status: h['jcr:content'] && h['jcr:content'].metadata && h['jcr:content'].metadata.status,
      }));
    },

    /** The bytes of a generated output (only from the Guides output folder). */
    async getBinary(assetPath) {
      if (!assetPath.startsWith('/content/dam/fmdita-outputs/') || assetPath.includes('..')) throw new Error('not an output file');
      const res = await fetch(`${origin}${encodePath(assetPath)}`, { headers: auth });
      if (!res.ok) throw fail(`read ${assetPath}`, res.status);
      return Buffer.from(await res.arrayBuffer());
    },

    async uploadText(folder, fileName, text, mime, { newVersion = false } = {}) {
      const assetFolder = validateFolder(folder);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(fileName)) throw new Error('invalid asset file name');
      const dir = fs.mkdtempSync(path.join(tmpdir, 'fmc-'));
      const filePath = path.join(dir, fileName);
      try {
        fs.writeFileSync(filePath, text, 'utf8');
        const fileSize = fs.statSync(filePath).size;
        const upload = new sdk.DirectBinaryUpload();
        const options = new sdk.DirectBinaryUploadOptions()
          .withUrl(`${origin}${encodePath(assetFolder)}`)
          .withUploadFiles([{
            fileName, fileSize, filePath, contentType: mime, ...(newVersion ? { createVersion: true, versionLabel: 'edited on the site' } : {}),
          }])
          .withHttpOptions({ headers: auth })
          .withConcurrent(false);
        const result = await upload.uploadFiles(options);
        const errors = (result && result.errors) || [];
        if (!result || result.totalCompleted !== 1 || errors.length) {
          throw new Error(`AEM upload failed for ${fileName}${errors[0] ? `: ${errors[0].message || errors[0].code}` : ''}`);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },

    // The Assets HTTP API writes these onto jcr:content itself; the Assets UI, Guides and
    // Query Builder all use the jcr:content/metadata node, so write there with a Sling POST.
    async setMetadata(assetPath, props, { clearEmpty = false } = {}) {
      validateFolder(path.posix.dirname(assetPath));
      const body = new URLSearchParams({ _charset_: 'utf-8' });
      Object.entries(props).forEach(([k, v]) => {
        if (v !== '' && v != null) body.set(k, String(v));
        else if (clearEmpty) body.set(`${k}@Delete`, ''); // an emptied field is removed, not kept
      });
      const res = await fetch(`${origin}${encodePath(assetPath)}/jcr:content/metadata`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!res.ok) throw fail(`write metadata ${assetPath}`, res.status);
    },

    async getMetadata(assetPath) {
      const res = await fetch(assetApiUrl(origin, assetPath), { headers: { ...auth, Accept: 'application/json' } });
      if (res.status === 404) return null;
      if (!res.ok) throw fail(`read ${assetPath}`, res.status);
      const body = await res.json();
      const p = body.properties || {};
      // Guides keeps its own keys in properties.metadata; ours may sit beside them
      return { ...p, ...(p.metadata && typeof p.metadata === 'object' ? p.metadata : {}) };
    },

    async getText(assetPath) {
      validateFolder(path.posix.dirname(assetPath));
      const res = await fetch(`${origin}${encodePath(assetPath)}`, { headers: auth });
      if (res.status === 404) return null;
      if (!res.ok) throw fail(`read ${assetPath}`, res.status);
      return res.text();
    },

    /** Most recently changed assets of one mime type under a DAM path (read only, for inspection). */
    async recent({ path: root, mime, limit = 15 }) {
      validateFolder(root);
      const qs = new URLSearchParams({
        path: root,
        type: 'dam:Asset',
        '1_property': 'jcr:content/metadata/dc:format',
        '1_property.value': mime,
        'p.hits': 'selective',
        'p.properties': 'jcr:path jcr:content/jcr:lastModified jcr:content/metadata/dc:title',
        'p.limit': String(limit),
        orderby: '@jcr:content/jcr:lastModified',
        'orderby.sort': 'desc',
      });
      const res = await fetch(`${origin}/bin/querybuilder.json?${qs}`, { headers: auth });
      if (!res.ok) throw fail('recent', res.status);
      const body = await res.json();
      return (body.hits || []).map((h) => ({
        path: h['jcr:path'], modified: h['jcr:content'] && h['jcr:content']['jcr:lastModified'], title: h['jcr:content'] && h['jcr:content'].metadata && h['jcr:content'].metadata['dc:title'],
      }));
    },

    async query({ path: root, statuses, limit = 100 }) {
      const fields = ['fmcFileName', 'fmcTitle', 'fmcStatus', 'fmcReviewer', 'fmcAuthor', 'fmcCreated', 'fmcModified', 'fmcPdf', 'dc:title'];
      const qs = new URLSearchParams({
        path: root,
        type: 'dam:Asset',
        nodename: '*.dita',
        excludepaths: '.*/cq:discarded/.*',
        '1_property': 'jcr:content/metadata/fmcStatus',
        'p.hits': 'selective',
        'p.properties': ['jcr:path', ...fields.map((f) => `jcr:content/metadata/${f}`)].join(' '),
        'p.limit': String(limit),
        orderby: '@jcr:content/metadata/fmcModified',
        'orderby.sort': 'desc',
      });
      statuses.forEach((s, i) => qs.set(`1_property.${i + 1}_value`, s));
      const res = await fetch(`${origin}/bin/querybuilder.json?${qs}`, { headers: auth });
      if (!res.ok) throw fail('query', res.status);
      const body = await res.json();
      return (body.hits || []).map((h) => ({
        path: h['jcr:path'],
        metadata: (h['jcr:content'] && h['jcr:content'].metadata) || {},
      }));
    },
  };
}

module.exports = { createAemClient };
