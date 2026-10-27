#!/bin/sh
# Provision an ORG-LEVEL AEM admin API key for a target org, so cross-org sync
# (sync-config / sync-da-sheet) can WRITE to that org's config and content.
#
# Why: the sync actions look up TOKEN_<ORG> to authenticate writes to another org.
# Without it they fall back to da-demo-kit's ADMIN_API_KEY, which cannot write
# another org -> cross-org sync fails. This script mints the per-org key you then
# store as that env var.
#
# PREREQUISITE: ynaka@adobe.com (whoever runs this) must be an ADMIN on the target
# org / its sites — added in the AEM Code Sync bot wizard's "Users" step. Only an
# admin can create keys.
#
# AUTH: export ADMIN_TOKEN with an admin credential that can create keys for the org
#   — your IMS/session token (default) OR an existing admin-role API key. NEVER hard-code
#   it and never pass it on the command line. If you use an API key instead of an IMS
#   token, set AUTH_HEADER="X-Auth-Token:".
#
# USAGE:
#   ADMIN_TOKEN=xxxxx ./provision-org-key.sh <target-org> [roles-csv]
#   ADMIN_TOKEN=xxxxx ./provision-org-key.sh ynakagawa admin
#   AUTH_HEADER="X-Auth-Token:" ADMIN_TOKEN=xxxxx ./provision-org-key.sh ynakagawa config,publish
#
# The key value is returned ONCE — store it immediately (see the printed env-var name).
set -e

ORG="$1"
ROLES="${2:-admin}"
AUTH_HEADER="${AUTH_HEADER:-Authorization: Bearer}"
API="https://admin.hlx.page"

if [ -z "$ORG" ] || [ -z "$ADMIN_TOKEN" ]; then
  echo "Usage: ADMIN_TOKEN=<admin-token> ./provision-org-key.sh <target-org> [roles-csv]" >&2
  exit 1
fi

# roles CSV -> JSON array, e.g. "config,publish" -> ["config","publish"]
ROLES_JSON=$(printf '%s' "$ROLES" | awk -F, '{printf "["; for(i=1;i<=NF;i++){printf "%s\"%s\"",(i>1?",":""),$i} printf "]"}')

echo "→ Creating ORG-level key for '$ORG' (roles: $ROLES_JSON)…" >&2
curl -sf -X POST "$API/config/$ORG/apiKeys.json" \
  -H "$AUTH_HEADER $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"description\":\"cross-org sync ($ORG)\",\"roles\":$ROLES_JSON}"

# Env var name the sync actions expect: TOKEN_<ORG uppercased, - -> _>
ENV="TOKEN_$(printf '%s' "$ORG" | tr 'a-z-' 'A-Z_')"
echo "" >&2
echo "" >&2
echo "⚠️  Copy the \"value\" above NOW — it is not retrievable again." >&2
echo "   Store it on the da-demo-kit runtime (Adobe I/O Runtime / App Builder) as:" >&2
echo "       $ENV=<the key value>" >&2
echo "   Then sync-config / sync-da-sheet can write to '$ORG'." >&2
echo "" >&2
echo "   VERIFY (host caveat): the key is minted on admin.hlx.page. sync-da-sheet also" >&2
echo "   uses admin.hlx.page (should work); sync-config uses admin.da.live — test that the" >&2
echo "   same key authorizes a config write there. If not, mint/store a DA-scoped token instead." >&2
