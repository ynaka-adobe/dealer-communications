/*
 * DA (Document Authoring) client for the communications sheets: read and write content under
 * admin.da.live, and preview/publish through admin.hlx.page so the cached sheet JSON that the
 * site reads is refreshed. Call shapes follow da-demo-kit's sync-da-sheet and publish actions.
 *
 * Auth: an IMS Server-to-Server token (client_credentials). The token's identity needs write
 * permission on the DA org (the `permissions` sheet). Publishing is a different realm: either the
 * same identity also holds a publish role on the site (site admin config), or a site API key with
 * the publish role is supplied as `publishKey`, which is then used for publishing instead.
 *
 * Alternatively a ready-made bearer token can be supplied as `staticToken` (da-demo-kit's long-lived
 * DA token). It is used only when the client-credential settings are incomplete, and it acts as the
 * person it was issued to, so prefer the S2S credential where possible.
 */
const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
const DA_SOURCE = 'https://admin.da.live/source';
const ADMIN = 'https://admin.hlx.page';

const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,200}$/;
const SAFE_ORG = /^[A-Za-z0-9._-]{1,64}$/;

function createDaClient({
  clientId, clientSecret, scopes, org, repo, publishKey = '', staticToken = '', fetchImpl = fetch,
}) {
  if (!SAFE_ORG.test(org) || !SAFE_ORG.test(repo)) throw new Error('invalid DA org or repo');
  let cached;

  async function token() {
    if (!clientId || !clientSecret || !scopes) {
      if (staticToken) return staticToken;
      throw new Error('no DA credential configured');
    }
    if (cached && cached.exp > Date.now() + 60000) return cached.value;
    const body = new URLSearchParams({
      grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret,
    });
    if (scopes) body.set('scope', String(scopes).replace(/\s+/g, ''));
    const res = await fetchImpl(IMS_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) throw new Error(`IMS token failed: ${res.status}`);
    cached = { value: json.access_token, exp: Date.now() + Number(json.expires_in || 3600) * 1000 };
    return cached.value;
  }

  const checked = (path) => {
    if (!SAFE_PATH.test(path) || path.includes('..') || path.includes('//')) throw new Error('invalid path');
    return path;
  };

  return {
    /** JSON stored at path, or null when it does not exist. */
    async getJson(path) {
      const res = await fetchImpl(`${DA_SOURCE}/${org}/${repo}/${checked(path)}`, { headers: { Authorization: `Bearer ${await token()}` } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`DA read ${path} -> ${res.status}`);
      return res.json();
    },

    async putJson(path, data) {
      const form = new FormData();
      form.append('data', new Blob([JSON.stringify(data)], { type: 'application/json' }), path.split('/').pop());
      const res = await fetchImpl(`${DA_SOURCE}/${org}/${repo}/${checked(path)}`, { method: 'PUT', headers: { Authorization: `Bearer ${await token()}` }, body: form });
      if (!res.ok) throw new Error(`DA write ${path} -> ${res.status}`);
    },

    /** Store a binary file (such as a PDF) at path. */
    async putBinary(path, bytes, type) {
      const form = new FormData();
      form.append('data', new Blob([bytes], { type }), path.split('/').pop());
      const res = await fetchImpl(`${DA_SOURCE}/${org}/${repo}/${checked(path)}`, { method: 'PUT', headers: { Authorization: `Bearer ${await token()}` }, body: form });
      if (!res.ok) throw new Error(`DA write ${path} -> ${res.status}`);
    },

    /** Delete a source file; a missing file is not an error. */
    async delete(path) {
      const res = await fetchImpl(`${DA_SOURCE}/${org}/${repo}/${checked(path)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${await token()}` } });
      if (!res.ok && res.status !== 404) throw new Error(`DA delete ${path} -> ${res.status}`);
    },

    /** Remove a deleted path from the preview and live sites. */
    async unpublish(path) {
      const t = await token();
      const headers = publishKey ? { 'X-Auth-Token': publishKey } : { Authorization: `Bearer ${t}`, 'X-Auth-Token': t };
      for (const action of ['live', 'preview']) {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetchImpl(`${ADMIN}/${action}/${org}/${repo}/main/${checked(path)}`, { method: 'DELETE', headers });
        if (!res.ok && res.status !== 404) throw new Error(`unpublish ${action} ${path} -> ${res.status}`);
      }
    },

    /** Preview then publish one path so the CDN serves the new content. */
    async publish(path) {
      // The admin service reads the page from the DA content source to preview it. When the org
      // restricts content reads, that read needs our DA token, which is handed over in
      // x-content-source-authorization. Authorizing the publish itself is separate: a site publish
      // key if one is configured, otherwise the same token (the identity needs a publish role).
      const t = await token();
      const headers = { 'x-content-source-authorization': `Bearer ${t}` };
      if (publishKey) {
        headers['X-Auth-Token'] = publishKey;
      } else {
        headers.Authorization = `Bearer ${t}`;
        headers['X-Auth-Token'] = t;
      }
      for (const action of ['preview', 'live']) {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetchImpl(`${ADMIN}/${action}/${org}/${repo}/main/${checked(path)}`, { method: 'POST', headers });
        if (!res.ok) {
          // the admin service explains refusals in x-error (no secrets in it)
          const why = res.headers && res.headers.get && res.headers.get('x-error');
          throw new Error(`publish ${action} ${path} -> ${res.status}${why ? ` (${String(why).slice(0, 160)})` : ''}`);
        }
      }
    },
  };
}

module.exports = { createDaClient };
