# Communications API

The contract between the Edge Delivery site and the service that fronts AEM. The site is only
the presentation layer: it never talks to AEM Author directly and holds no AEM credentials.

Client: [scripts/communications-api.js](../scripts/communications-api.js). Page metadata (all values
are same-origin paths) chooses where data comes from:

| Metadata | Effect |
|---|---|
| none | mock: sample data; drafts kept in the browser session |
| `communications-data` = `/data` | the **lists** are read from the published sheets `/data/notifications.json` (active) and `/data/archive.json`. Static, cached JSON: listing never calls AEM. |
| `communications-api` = `/api/fmc` | the service for detail, create and status, called on submission and other key events |
| `communications-draft-save` = `true` | each form step is saved through the service to a sheet (no AEM call) so a draft survives a reload and appears in the list |

### Sheets

Both list sheets have the columns `id, fileName, title, status, reviewer, author, created, modified,
locked, aemPath` (every cell a string; `locked` is `true` or `false`). In-progress drafts are stored
by the service as `/data/drafts/<id>.json` (never published). The service updates a sheet row and
republishes only when the row actually changes, so saving a step that changes nothing is free.

Only paths on the site's own origin are accepted as a base. Optional metadata
`communications-poll` sets the list refresh interval in seconds (5 to 600, default 30).

The edge function forwards `/api/fmc/*` to the real service (for example App Builder actions in
front of AEM Author) and adds the signed-in user (Okta CDSID, groups) so the service can enforce
access and record the author.

## Endpoints (all under the base, JSON)

### GET /communications?type=active|archive
Rows for the list or the archive.
```json
[{ "id": "draft-91", "fileName": "EFC260091", "title": "...", "status": "REVIEWER PENDING",
   "reviewer": "mshanm26", "author": "sgorle1", "created": "2026-10-23T14:01:26",
   "modified": "2026-10-23T14:03:57", "locked": false }]
```
`status` is one of DRAFT, REVIEWER PENDING, FINAL APPROVAL PENDING, PUBLISHED, UNPUBLISH.
`created` and `modified` are ISO 8601 without a zone, in the service's local time.

### GET /communications/{fileName}
The document for the preview page, or 404.
```json
{ "title": "...", "fields": [["Field Publish Date", "May 5, 2026"]], "body": "<h2>...</h2><p>...</p>" }
```
`body` is an HTML fragment (for example the HTML export of the approved content). The site
sanitizes it before rendering.

### POST /communications
Creates a draft from the Create Draft form. Body is the form payload (title, division, channel,
reviewer, alternate, concurring, originator, businessContact, dates, audiences, rich-text sections,
attachment file names). Returns `201`:
```json
{ "id": "draft-91", "fileName": "EFC260091", "status": "DRAFT" }
```
`422` when `title` is missing, `400` for invalid JSON. Attachment files are not part of this call;
upload them separately once the draft exists.

### PUT /drafts/{id}
Saves the form's progress (body: the form state). `{id}` is `DRAFT-<14 digits>-<4 lowercase
alphanumerics>`, chosen by the form. Stores the state in a sheet document and lists the draft
(status DRAFT) in `/data/notifications.json`. Only the caller who started a draft can update it.
`503` when the service has no DA credential, in which case the form just keeps the draft in the page.
Submitting with `POST /communications` and the same `draftId` creates the AEM asset under that id.

### GET /communications/{id}/status
```json
{ "id": "draft-91", "status": "FINAL APPROVAL PENDING", "updated": "2026-10-23T14:03:57" }
```

## Mapping to AEM (proposed)

| API | AEM side |
|---|---|
| POST /communications | create an asset (or Guides topic) under the communications folder; form fields become metadata; rich-text sections become the content |
| GET /communications | Assets search by folder and status metadata |
| status | workflow or review status exposed as asset metadata |
| GET /communications/{fileName} | the published HTML rendition of the approved asset |
| final approval | triggers the PDF and HTML export |

## Try it locally

```bash
node tools/communications-stub/server.mjs
# http://localhost:8788/tools/communications-stub/
```

The stub serves the site and this API on one origin, keeps drafts in memory, and moves each new
draft through the states on a timer (15s each) so the list can be watched updating. It is for
development only and listens on localhost.
