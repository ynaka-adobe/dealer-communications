/**
 * Sync a DA sheet from source (da-demo-kit) to target repo.
 *
 * Usage:
 *   GET /actions/sync-da-sheet?targetOrg=my-org&targetRepo=my-site&sheetPath=.da/adobe-target.json
 *
 * Auth (primary -> fallback), same token used for BOTH source read and target write —
 * valid as long as its identity is granted access in both orgs' `permissions` sheets
 * (read on da-demo-kit, write on the target). See actions/PROVISIONING.md.
 *   1. ?accessToken=...                      (explicit override, for testing)
 *   2. DA_Token from da-demo-kit `.da/adobe-da`  (read with the helix ADMIN_API_KEY)  <- primary
 *   3. IMS Server-to-Server minted token     (IMS_CLIENT_ID/SECRET/SCOPES)            <- fallback
 *
 * Env:
 *   ADMIN_API_KEY                              (to read the DA_Token sheet — primary path)
 *   IMS_CLIENT_ID, IMS_CLIENT_SECRET, IMS_SCOPES  (S2S fallback)
 *
 * Returns:
 *   { success: true, source: {...}, target: {...} }
 */

const DA_API_BASE = 'https://admin.da.live/source';
const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
const SOURCE_API_BASE = 'https://admin.hlx.page/source';
const DA_TOKEN_SHEET = '.da/adobe-da.json';

/**
 * Read the long-lived DA_Token from da-demo-kit's `.da/adobe-da` sheet.
 * The sheet is fetched from the helix source host with the helix ADMIN_API_KEY
 * (which works on admin.hlx.page); the DA_Token it holds is then used as the
 * Bearer for the admin.da.live source calls. Returns null if ADMIN_API_KEY isn't set.
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

async function fetchSheet(org, repo, path, accessToken) {
  const url = `${DA_API_BASE}/${org}/${repo}${path.startsWith('/') ? path : '/' + path}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch ${path}: ${resp.status} ${resp.statusText}`);
  }

  return resp.json();
}

async function updateSheet(org, repo, path, content, accessToken) {
  const url = `${DA_API_BASE}/${org}/${repo}${path.startsWith('/') ? path : '/' + path}`;

  const formData = new FormData();
  formData.append('data', new Blob([JSON.stringify(content)], { type: 'application/json' }), path.split('/').pop());

  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: formData,
  });

  if (!resp.ok) {
    throw new Error(`Failed to update ${path}: ${resp.status} ${resp.statusText}`);
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
  const sheetPath = params.sheetPath || '.da/adobe-target.json';
  const targetOrg = params.targetOrg || params.org;
  const targetRepo = params.targetRepo || params.site || params.repo;

  if (!targetOrg || !targetRepo) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'Missing required parameters: targetOrg and targetRepo',
        example: '/actions/sync-da-sheet?targetOrg=my-org&targetRepo=my-site&sheetPath=.da/adobe-target.json',
      }),
      headers: { 'Content-Type': 'application/json' },
    };
  }

  // Auth resolution (primary -> fallback). The same token authorizes both the source
  // read and the target write, given its identity is granted access in both orgs'
  // `permissions` sheets (read on da-demo-kit, write on the target).
  //   1. ?accessToken=  (explicit override, for testing)
  //   2. DA_Token from da-demo-kit's `.da/adobe-da` sheet (read with the helix ADMIN_API_KEY)
  //   3. IMS Server-to-Server minted token (IMS_CLIENT_ID/SECRET/SCOPES)
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
  }

  if (!token) {
    return {
      statusCode: 401,
      body: JSON.stringify({
        error: 'Missing authentication',
        detail: authError,
        solutions: [
          'Primary: set ADMIN_API_KEY so the action can read DA_Token from da-demo-kit `.da/adobe-da`',
          'Fallback: set IMS_CLIENT_ID / IMS_CLIENT_SECRET (and IMS_SCOPES) for the S2S technical account',
          'Grant the identity write on CONFIG in the target org\'s `permissions` sheet (see PROVISIONING.md)',
          'Or pass ?accessToken=YOUR_TOKEN to override for testing',
        ],
      }),
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    };
  }

  try {
    // Fetch from source, push to target — same S2S token for both.
    const sourceContent = await fetchSheet(sourceOrg, sourceRepo, sheetPath, token);
    await updateSheet(targetOrg, targetRepo, sheetPath, sourceContent, token);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: `Synced ${sheetPath} from ${sourceOrg}/${sourceRepo} to ${targetOrg}/${targetRepo}`,
        source: { org: sourceOrg, repo: sourceRepo, path: sheetPath },
        target: { org: targetOrg, repo: targetRepo, path: sheetPath },
        content: sourceContent,
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
