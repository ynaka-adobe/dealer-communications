# Platform dependencies (things that live outside this repo)

This site needs pieces that are configured in other places. If one is missing, the site can look fine and still
fail (for example no guest codes, or no backend). Check this list when something behaves oddly or before a demo.
Run `service/bin/check-site` to test what can be tested from outside.

| Piece | Where it lives | Needed for | Status |
|---|---|---|---|
| Site code (blocks, scripts, styles) | this repo, `main` | everything, via AEM Code Sync | in place |
| Content and list sheets | Document Authoring, `ynaka-adobe/dealer-communications` | pages, nav, footer, `/data/*` | in place |
| Edge Delivery site | Cloud Manager, program 154856, "Edge Delivery Sites" | serving the site | registered |
| Domain `dealer-communications.ynaka-adobe.com` | Cloud Manager (SSL Certificates, Domain Mappings) plus DNS | the custom domain | in place (answers 200 on 2026-10-28) |
| CDN route to the edge function | `config-eds/cdn.yaml` in `ynaka-adobe/AEM-p154856`, deployed by config pipeline `60291285` | the edge function, for the API proxy and guest codes (decided: yes) | in place (AEM-p154856 PR #23, applied by the EDS config pipeline on 2026-10-28) |
| Edge function site entry | `edge-functions-xsc-demo/src/sites.js` in `ynaka-adobe/AEM-p154856`, deployed with `aio aem-edge-functions` | the `/api/fmc` proxy to the service (adds the shared secret) and guest codes at `/auth/code` (decided: yes) | in place (PR #23; deployed as package 47 on 2026-10-28; edge secret `XSC_DEALER_COMMUNICATIONS_API_SECRET` equals the service's `DC_ACTION_SECRET`). The new package took a few minutes to reach the CDN. |
| Backend service | App Builder project, code in `service/` of this repo | create, review, approve, PDFs | deployed to the Stage workspace of project `dealercommunications` (web action `…adobeioruntime.net/api/v1/web/dealer-communications/communications`); AEM credential stored with `configure`; alarm triggers `dc-every-minute` (`pdf-poll`) and `dc-every-10-min` (`reconcile`) created by hand with `aio rt trigger/rule create` (not part of `app.config.yaml`); `DC_PDF_OUTPUT` / `DC_PDF_PARAMS` set to the global Native PDF preset |
| AEM Author folder | `/content/dam/dealer-communications` on program 154856 | DITA records and PDFs | created by the service on the first draft |
| AEM Guides PDF template | AEM Assets `/content/dam/dita-templates/pdf/Dealer/`; the global Native PDF preset (`c0c81768-…`) must have Template set to it (saved from a map's Output tab in Guides). That preset is shared with the FMC site | the PDF layout | in place; `img.svg` logo is missing from the template folder |
| AEM Author API allowlist | `config/api.yaml` in `ynaka-adobe/AEM-p154856`, applied by the **AEM Config** pipeline (Cloud Manager, config location `/config`, environments 1944904 and 1944736) | the service's calls to AEM Author (the client ID of the `dealercommunications` OAuth credential must be listed) | in place; a new credential needs its client ID added and the pipeline run again |
| AEM product profile | Admin Console, Author profiles for program 154856 environment 1944736, attached to the credential's AEM Assets Author API | the service's access to Author | in place |
| Analytics | report suite `acsmarketingdealernotification` (shared with the FMC demo) | page and event hits | configured in `scripts/analytics-config.js` |

## Check (2026-10-28)
`service/bin/check-site` shows: custom domain 200, `/auth/code` 405, `/api/fmc/communications?type=active` 200
(an empty list until the first draft). `xsc-demo` and the FMC site were unaffected by the deploy.

## Order of work
1. Certificate ready, domain mapping, DNS.
2. Create the App Builder project, deploy `service/`, note the action URL.
3. Add the `api` block (upstream URL and secret key name) to the site entry in `sites.js`, then merge the pull
   request in `AEM-p154856`.
4. Run config pipeline `60291285` (the `cdn.yaml` route), then deploy the edge function with the plugin.
5. Run `service/bin/check-site` and confirm every line shows the wanted code.

## Gotchas learned
- The EDS config pipeline (`AEM-p154856`, `/config-eds`) does not apply `/config`. The AEM Config pipeline does.
- AEM refuses a token without `additional_info.projectedProductContext` ("missing required scopes"), so
  the stored scope list in `service/actions/configure` includes it.
- A config pipeline can fail once with "SPF did not acknowledge this configuration update". Running it
  again worked.

## Rules
- A change to the edge function or CDN config is a pull request in `ynaka-adobe/AEM-p154856`, not here. Link it
  from the pull request in this repo that needs it.
- A CDN route sends all of the host's traffic through the function. If the function fails, the site fails.
- Secrets never go in either repo: `.env` files and credential JSON files stay local (see `.gitignore`).
- When you deploy or change any row above, update its Status here in the same change.
