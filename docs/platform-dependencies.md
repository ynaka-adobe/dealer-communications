# Platform dependencies (things that live outside this repo)

This site needs pieces that are configured in other places. If one is missing, the site can look fine and still
fail (for example no guest codes, or no backend). Check this list when something behaves oddly or before a demo.
Run `service/bin/check-site` to test what can be tested from outside.

| Piece | Where it lives | Needed for | Status |
|---|---|---|---|
| Site code (blocks, scripts, styles) | this repo, `main` | everything, via AEM Code Sync | in place |
| Content and list sheets | Document Authoring, `ynaka-adobe/dealer-communications` | pages, nav, footer, `/data/*` | in place |
| Edge Delivery site | Cloud Manager, program 154856, "Edge Delivery Sites" | serving the site | registered |
| Domain `dealer-communications.ynaka-adobe.com` | Cloud Manager (SSL Certificates, Domain Mappings) plus DNS | the custom domain | certificate pending when last checked |
| CDN route to the edge function | `config-eds/cdn.yaml` in `ynaka-adobe/AEM-p154856`, deployed by config pipeline `60291285` | only if the edge function is wanted | not decided or deployed |
| Edge function site entry | `edge-functions-xsc-demo/src/sites.js` in `ynaka-adobe/AEM-p154856`, deployed with `aio aem-edge-functions` | guest codes at `/auth/code`, and the `/api` proxy to the service | not decided or deployed |
| Backend service | App Builder project, code in `service/` of this repo | create, review, approve, PDFs | not created or deployed |
| AEM Author folder | `/content/dam/dealer-communications` on program 154856 | DITA records and PDFs | not created |
| AEM Guides PDF template | AEM Assets, a neutral copy of the Native PDF template | the PDF layout | not created |
| Analytics | report suite `acsmarketingdealernotification` (shared with the FMC demo) | page and event hits | configured in `scripts/analytics-config.js` |

## Rules
- A change to the edge function or CDN config is a pull request in `ynaka-adobe/AEM-p154856`, not here. Link it
  from the pull request in this repo that needs it.
- A CDN route sends all of the host's traffic through the function. If the function fails, the site fails.
- Secrets never go in either repo: `.env` files and credential JSON files stay local (see `.gitignore`).
- When you deploy or change any row above, update its Status here in the same change.
