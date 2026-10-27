/**
 * Publish (preview + live) pages on a target site via the AEM admin service.
 *
 * This is a PROBE: it tests whether the IMS token minted from the S2S credential
 * (the same one sync-config uses) is honored by admin.hlx.page — a DIFFERENT auth
 * realm from admin.da.live. It reports the raw preview/live status per path instead
 * of throwing, so a 401 is visible rather than fatal.
 *
 * Usage:
 *   GET /publish?targetOrg=my-org&targetRepo=my-site&paths=,nav,footer
 *   (paths = comma-separated; empty segment = homepage. Defaults to the homepage.)
 *
 * Auth (primary -> override):
 *   1. ?accessToken=...                          (explicit override, for testing)
 *   2. IMS Server-to-Server minted token         (IMS_CLIENT_ID/SECRET/SCOPES)
 *
 * For publish to succeed, the token's identity must ALSO hold a publish/admin role
 * on the site in the helix realm (bot wizard Users step / site admin config) — the
 * DA `permissions` grant does not apply here.
 */

const ADMIN_API_BASE = 'https://admin.hlx.page';
const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';

/**
 * Mint an IMS access token via the client_credentials (Server-to-Server) grant.
 * Returns null if S2S credentials aren't configured.
 */
async function getImsToken(params) {
  const clientId = params.IMS_CLIENT_ID || process.env.IMS_CLIENT_ID;
  const clientSecret = params.IMS_CLIENT_SECRET || process.env.IMS_CLIENT_SECRET;
  const scope = params.IMS_SCOPES || process.env.IMS_SCOPES;

  if (!clientId || !clientSecret) return null;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (scope) body.append('scope', scope);

  const resp = await fetch(IMS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!resp.ok) {
    throw new Error(`IMS token request failed: ${resp.status} ${resp.statusText}`);
  }

  const json = await resp.json();
  if (!json.access_token) {
    throw new Error('IMS token response had no access_token');
  }
  return json.access_token;
}

/**
 * POST an admin action (preview|live) for one path. Returns the raw status without
 * throwing, so a 401/403 is reported rather than aborting the probe.
 */
async function adminPost(action, org, repo, path, token) {
  const clean = path.replace(/^\//, '');
  const url = `${ADMIN_API_BASE}/${action}/${org}/${repo}/main/${clean}`;

  // Try both auth styles: IMS Bearer (user/profile token) and X-Auth-Token (API key).
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Auth-Token': token,
    },
  });

  let detail;
  try {
    detail = await resp.text();
  } catch (e) {
    detail = '';
  }

  return {
    action,
    path: path || '(homepage)',
    status: resp.status,
    ok: resp.ok,
    url,
    detail: detail ? detail.slice(0, 300) : undefined,
  };
}

async function main(params) {
  if (params.__ow_method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      },
    };
  }

  const targetOrg = params.targetOrg || params.org;
  const targetRepo = params.targetRepo || params.site || params.repo;

  if (!targetOrg || !targetRepo) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'Missing required parameters: targetOrg and targetRepo',
        example: '/publish?targetOrg=my-org&targetRepo=my-site&paths=,nav,footer',
      }),
      headers: { 'Content-Type': 'application/json' },
    };
  }

  // paths: comma-separated; empty segment => homepage. Default = homepage only.
  const paths =
    typeof params.paths === 'string'
      ? params.paths.split(',').map((p) => p.trim())
      : [''];

  let token = params.accessToken;
  let authError = null;
  if (!token) {
    try {
      token = await getImsToken(params);
    } catch (err) {
      authError = `IMS S2S: ${err.message}`;
    }
    if (!token && !authError) authError = 'IMS_CLIENT_ID / IMS_CLIENT_SECRET not set';
  }

  if (!token) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Missing authentication', detail: authError }),
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    };
  }

  // Preview each path, then live each path. Report every result.
  const results = [];
  for (const p of paths) {
    results.push(await adminPost('preview', targetOrg, targetRepo, p, token));
  }
  for (const p of paths) {
    results.push(await adminPost('live', targetOrg, targetRepo, p, token));
  }

  const allOk = results.every((r) => r.ok);

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: allOk,
      message: allOk
        ? `Published ${paths.length} path(s) on ${targetOrg}/${targetRepo}`
        : 'Some publish calls failed — see results (a 401/403 means the IMS token is not honored on admin.hlx.page for this site)',
      target: { org: targetOrg, repo: targetRepo },
      results,
    }),
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  };
}

exports.main = main;
