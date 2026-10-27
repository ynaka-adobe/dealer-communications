# DA Content Sync

Automatically sync Document Authoring (DA) sheets from the da-demo-kit source to any target repo. Perfect for populating shared credentials, configurations, or content templates across multiple demo sites.

## Features

- **One-click sync** — web UI form for non-technical users
- **Programmatic sync** — REST API for automation
- **Multi-sheet support** — sync Adobe Target, Workfront, or custom sheets
- **Flexible auth** — supports multiple auth methods for different repos
- **Error handling** — clear status messages and troubleshooting hints

## Quick Start

### For end users

1. Navigate to `https://your-site.hlx.live/sync-content`
2. Enter target organization and repository name
3. Select which sheet to sync (default: Adobe Target credentials)
4. Click **"Sync Content"**

### For developers

**Sync via API:**
```bash
curl "https://your-site.hlx.live/actions/sync-da-sheet?targetOrg=my-org&targetRepo=my-site"
```

**Sync custom sheet:**
```bash
curl "https://your-site.hlx.live/actions/sync-da-sheet?targetOrg=my-org&targetRepo=my-site&sheetPath=.da/my-custom-sheet.json"
```

## API Reference

### Endpoint
```
GET /actions/sync-da-sheet
```

### Query Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `targetOrg` | Yes | — | GitHub organization of target repo |
| `targetRepo` | Yes | — | Repository/site name |
| `sheetPath` | No | `.da/adobe-target.json` | Path to sheet to sync |
| `accessToken` | No | — | Auth token (overrides env vars) |

### Response

**Success (200):**
```json
{
  "success": true,
  "message": "Synced .da/adobe-target.json from ynaka-adobe/da-demo-kit to my-org/my-site",
  "source": {
    "org": "ynaka-adobe",
    "repo": "da-demo-kit",
    "path": ".da/adobe-target.json"
  },
  "target": {
    "org": "my-org",
    "repo": "my-site",
    "path": ".da/adobe-target.json"
  },
  "content": { ... }
}
```

**Error (400/401/500):**
```json
{
  "error": "Error message",
  "hint": "Troubleshooting hint",
  "solutions": ["Option 1", "Option 2"]
}
```

## Authentication

The sync action supports multiple auth methods, in order of priority:

### 1. Pass token directly (highest priority)
```bash
curl "https://your-site.hlx.live/actions/sync-da-sheet?targetOrg=my-org&targetRepo=my-site&accessToken=YOUR_TOKEN"
```

### 2. Set environment variables (for deployed sites)

**For da-demo-kit source:**
```bash
export ADMIN_API_KEY=your_token_here
```

**For target repos in other orgs:**
```bash
# For org "my-org", set TOKEN_MY_ORG
export TOKEN_MY_ORG=your_token_here

# For org "acme-corp", set TOKEN_ACME_CORP
export TOKEN_ACME_CORP=your_token_here
```

#### Setting env vars in Helix

Add to your site's `.helix/config.yaml` or Helix dashboard:

```yaml
env:
  ADMIN_API_KEY: ${HELIX_ADMIN_API_KEY}
  TOKEN_MY_ORG: ${HELIX_TOKEN_MY_ORG}
  TOKEN_ACME_CORP: ${HELIX_TOKEN_ACME_CORP}
```

Then store the actual tokens in your Helix deployment secrets (not in git).

## Available Sheets

The following sheets are pre-configured and ready to sync:

### `.da/adobe-target.json` (default)
Adobe Target configuration including:
- `clientId` — Target API client ID
- `clientSecret` — Target API secret
- `tenant` — Target tenant (acsmarketing)

**Source:** `ynaka-adobe/da-demo-kit`

### `.da/adobe-workfront.json`
Adobe Workfront configuration (if configured in source)

**Source:** `ynaka-adobe/da-demo-kit`

### Custom sheets
Sync any other sheet by providing its path:
```bash
curl "https://your-site.hlx.live/actions/sync-da-sheet?targetOrg=my-org&targetRepo=my-site&sheetPath=.da/my-sheet.json"
```

## Troubleshooting

### "Missing required parameters"
**Error:** Ensure you've provided both `targetOrg` and `targetRepo`

**Example:**
```bash
# ✗ Missing parameter
curl "https://your-site.hlx.live/actions/sync-da-sheet"

# ✓ Correct
curl "https://your-site.hlx.live/actions/sync-da-sheet?targetOrg=my-org&targetRepo=my-site"
```

### "Missing authentication"
**Error:** No auth token found

**Solution:** Choose one:
1. Pass `accessToken` parameter: `?accessToken=YOUR_TOKEN`
2. Set `ADMIN_API_KEY` env var
3. Set org-specific token: `TOKEN_MY_ORG=...`

**To get a token:**
- Use your GitHub personal access token (needs `repo` scope)
- Or use an Adobe/AEM authentication token if applicable

### "Failed to fetch / access denied"
**Error:** Auth token doesn't have access to source or target repo

**Solution:**
1. Verify token has `repo` scope (for GitHub tokens)
2. Verify token is valid and not expired
3. Ensure token has access to both source (`ynaka-adobe/da-demo-kit`) and target orgs

### "Sheet not found" (404)
**Error:** The sheet path doesn't exist in source repo

**Solution:**
1. Verify the sheet exists: `https://da.live/sheet#/ynaka-adobe/da-demo-kit/.da/adobe-target.json`
2. Check the exact path (case-sensitive): `.da/adobe-target.json` not `.da/adobe-target`
3. Contact admin if the sheet should exist

## Use Cases

### 1. Deploy new demo sites
Create a new EDS repo → Sync Target credentials → Done!

```bash
# After create-eds-repo
curl "https://new-site.hlx.live/actions/sync-da-sheet?targetOrg=my-org&targetRepo=new-site"
```

### 2. Bulk sync across multiple repos
Script to sync all demo sites:

```bash
#!/bin/bash
sites=("demo-1" "demo-2" "demo-3")
for site in "${sites[@]}"; do
  curl "https://source.hlx.live/actions/sync-da-sheet?targetOrg=my-org&targetRepo=$site"
  echo "Synced $site"
done
```

### 3. Automated CI/CD integration
Trigger sync in your deployment pipeline:

```yaml
# Example GitHub Actions workflow
- name: Sync DA Content
  run: |
    curl "${{ secrets.SITE_URL }}/actions/sync-da-sheet?targetOrg=${{ env.ORG }}&targetRepo=${{ env.REPO }}&accessToken=${{ secrets.ADMIN_TOKEN }}"
```

## Architecture

```
┌─────────────────────┐
│  End User (UI)      │
│  /sync-content.html │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────────┐
│  Helix Action           │
│ /actions/sync-da-sheet  │
└──────────┬──────────────┘
           │
      ┌────┴─────┐
      │           │
      ▼           ▼
  Source Repo   Target Repo
  (read)        (write)
```

## Actions

### `/actions/sync-config` — Full config sync
Sync entire configuration (library, apps, prepare, data sheets) in one call.

**Usage:**
```bash
curl "https://your-site.hlx.live/actions/sync-config?targetOrg=my-org&targetRepo=my-site"
```

**Perfect for:**
- Creating new demo sites with full default setup
- End users who want all config in one click
- Automating demo site provisioning

### `/actions/sync-da-sheet` — Individual sheet sync
Sync specific sheets or credentials.

**Usage:**
```bash
curl "https://your-site.hlx.live/actions/sync-da-sheet?targetOrg=my-org&targetRepo=my-site&sheetPath=.da/adobe-target.json"
```

## Files

- `sync-content.html` — Web UI with both config and sheet sync options
- `actions/sync-config/index.js` — Full config sync action
- `actions/sync-da-sheet/index.js` — Individual sheet sync action
- `SYNC_README.md` — This file

## Next Steps

1. **Deploy to production** — commit and deploy these files
2. **Share the UI URL** — give end users `https://your-site.hlx.live/sync-content`
3. **Set up auth tokens** — configure env vars for target repos
4. **Test sync** — verify sheets appear in target repos

## Support

- **UI not loading?** Ensure `sync-content.html` is deployed and accessible
- **API returning errors?** Check troubleshooting section above
- **Need to sync more sheets?** Add them to the dropdown in `sync-content.html` or use custom path
- **Issues?** Contact your demo admin or check server logs

## Future Enhancements

- [ ] Sync multiple sheets in one call
- [ ] Schedule periodic sync (cron job)
- [ ] Sync content pages (not just `.da/` sheets)
- [ ] Audit log of synced content
- [ ] Rollback to previous version
