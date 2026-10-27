/**
 * Sync entire DA config (library, apps, prepare, data sheets) from da-demo-kit to target repo.
 *
 * Usage:
 *   GET /actions/sync-config?targetOrg=my-org&targetRepo=my-site
 *
 * Auth (primary -> fallback), same token used for BOTH source read and target write —
 * valid as long as its identity is granted access in both orgs' `permissions` sheets
 * (read on da-demo-kit, write on the target). See actions/PROVISIONING.md.
 *   1. ?accessToken=...                      (explicit override, for testing)
 *   2. IMS Server-to-Server minted token     (IMS_CLIENT_ID/SECRET/SCOPES)  <- primary
 *
 * The action stores only the S2S client_id/secret/scopes as runtime secrets and exchanges
 * them for a fresh IMS Bearer per call (grant_type=client_credentials) — nothing long-lived
 * to store or rotate. The minted token's technical-account identity is what the target org's
 * `permissions` sheet must grant `write` (its two IMS org IDs). See actions/PROVISIONING.md.
 *
 * Env:
 *   IMS_CLIENT_ID, IMS_CLIENT_SECRET, IMS_SCOPES  (S2S technical account)
 *
 * Returns:
 *   { success: true, config: {...} }
 */

const CONFIG_API_BASE = 'https://admin.da.live/config';
const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
const SOURCE_API_BASE = 'https://admin.hlx.page/source';
const DA_TOKEN_SHEET = '.da/adobe-da.json';

/**
 * Read the long-lived DA_Token from da-demo-kit's `.da/adobe-da` sheet.
 * The sheet is fetched from the helix source host with the helix ADMIN_API_KEY
 * (which works on admin.hlx.page); the DA_Token it holds is then used as the
 * Bearer for the admin.da.live config calls. Returns null if ADMIN_API_KEY isn't set.
 */
async function getDaToken(org, repo, params) {
  const key = params.ADMIN_API_KEY || process.env.ADMIN_API_KEY;
  if (!key) return null;

  const url = `${SOURCE_API_BASE}/${org}/${repo}/${DA_TOKEN_SHEET}`;
  const resp = await fetch(url, {
    headers: { 'X-Auth-Token': key, Accept: 'application/json' },
  });

  if (!resp.ok) {
    throw new Error(`Failed to read DA_Token sheet (${DA_TOKEN_SHEET}): ${resp.status} ${resp.statusText}`);
  }

  const sheet = await resp.json();
  const rows = Array.isArray(sheet.data) ? sheet.data : [];
  const row = rows.find((r) => r.key === 'DA_Token');
  if (!row || !row.value) {
    throw new Error('DA_Token row not found in .da/adobe-da sheet');
  }
  return row.value;
}

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

async function fetchConfig(org, repo, accessToken) {
  const url = `${CONFIG_API_BASE}/${org}/${repo}/?nocache=${Date.now()}`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch config from ${org}/${repo}: ${resp.status} ${resp.statusText}`);
  }

  return resp.json();
}

async function pushConfig(org, repo, configData, accessToken) {
  const url = `${CONFIG_API_BASE}/${org}/${repo}/`;

  // Send config as a form parameter (not a JSON body)
  const formData = new URLSearchParams();
  formData.append('config', JSON.stringify(configData));

  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: formData,
  });

  if (!resp.ok) {
    throw new Error(`Failed to push config to ${org}/${repo}: ${resp.status} ${resp.statusText}`);
  }

  return resp.json();
}

async function main(params) {
  // CORS preflight
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

  const sourceOrg = 'ynaka-adobe';
  const sourceRepo = 'da-demo-kit';
  const targetOrg = params.targetOrg || params.org;
  const targetRepo = params.targetRepo || params.site || params.repo;

  if (!targetOrg || !targetRepo) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'Missing required parameters: targetOrg and targetRepo',
        example: '/actions/sync-config?targetOrg=my-org&targetRepo=my-site',
      }),
      headers: { 'Content-Type': 'application/json' },
    };
  }

  // Auth resolution (primary -> fallback). The same token authorizes both the source
  // read and the target write, given its identity is granted access in both orgs'
  // `permissions` sheets (read on da-demo-kit, write on the target).
  //   1. ?accessToken=  (explicit override, for testing)
  //   2. IMS Server-to-Server minted token (IMS_CLIENT_ID/SECRET/SCOPES)
  let token = params.accessToken;
  let authError = null;

  if (!token) {
    try {
      token = await getDaToken(sourceOrg, sourceRepo, params); // DA_Token from the sheet (primary)
    } catch (err) {
      authError = `DA_Token: ${err.message}`;
    }
  }

  if (!token) {
    try {
      token = await getImsToken(params); // S2S fallback
    } catch (err) {
      authError = `IMS S2S: ${err.message}`;
    }
    if (!token && !authError) authError = 'IMS_CLIENT_ID / IMS_CLIENT_SECRET not set';
  }

  if (!token) {
    return {
      statusCode: 401,
      body: JSON.stringify({
        error: 'Missing authentication',
        detail: authError,
        solutions: [
          'Set IMS_CLIENT_ID / IMS_CLIENT_SECRET (and IMS_SCOPES) so the action can mint an IMS token',
          'Grant that technical account write on CONFIG in the target org\'s `permissions` sheet (see PROVISIONING.md)',
          'Or pass ?accessToken=YOUR_TOKEN to override for testing',
        ],
      }),
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    };
  }

  try {
    // Fetch config from source, push to target — same S2S token for both.
    const sourceConfig = await fetchConfig(sourceOrg, sourceRepo, token);
    await pushConfig(targetOrg, targetRepo, sourceConfig, token);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: `Synced config from ${sourceOrg}/${sourceRepo} to ${targetOrg}/${targetRepo}`,
        source: { org: sourceOrg, repo: sourceRepo },
        target: { org: targetOrg, repo: targetRepo },
        config: sourceConfig,
      }),
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err.message,
        hint: 'A 401/403 here usually means the S2S identity lacks write on the target org\'s `permissions` sheet (CONFIG + content). See PROVISIONING.md.',
      }),
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    };
  }
}

exports.main = main;
