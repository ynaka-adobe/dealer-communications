# Dealer Communications service

Adobe App Builder (I/O Runtime) service, kept in the `service/` folder of the site repo (`.hlxignore` keeps it
out of Edge Delivery), behind the Dealer Communications site
(`ynaka-adobe/dealer-communications`). It keeps communications in AEM Assets as DITA, generates PDFs with AEM
Guides, and keeps the list sheets (`/data/notifications`, `/data/archive`) in Document Authoring in step.

Actions (package `dealer-communications`): `communications` (web, called only by the site's edge function with a
shared secret), `reconcile`, `pdf-poll` (alarm triggers) and `admin` (operator operations, see `bin/dealer`).

Copied from the earlier FMC demo service and renamed. Internal identifiers such as the `fmc*` metadata property
names, the `x-fmc-*` headers and the `lib/fmc` folder are unchanged.

## Set up (not done yet)
1. Create an App Builder project and a workspace in the Developer Console, then `aio app use` it in this folder.
   Do not reuse another project.
2. Copy `.env.example` to `.env` and fill it in (never commit it): `DC_ACTION_SECRET`, `DC_REVIEW_CODE`,
   `DC_PDF_OUTPUT`, `DC_PDF_PARAMS`, `DC_PUBLISH_HOST`, `DA_CLIENT_ID`, `DA_CLIENT_SECRET`, `DA_SCOPES`,
   `DA_PUBLISH_KEY`, `DA_TOKEN`.
3. AEM Author access: the actions read the host and credential from app state key `config:aem`. This project has no
   action yet that writes it (the old project did). It must be added before the first deploy.
4. `npm install`, then `npm test`, then `aio app deploy`.
5. Point the site's edge function entry (`api` in `src/sites.js`) at the deployed `communications` action and set
   the shared secret there.
6. Create the AEM folder `/content/dam/dealer-communications`, then run `bin/dealer setup-guides`.
