# Dealer Communications: Adobe Analytics

The same measurement design as the 3M, TEBG and Parker sites, so the **Engagement & Conversion
Workspace** build guide works on this site unchanged. Blocks are measured automatically; the
Create Draft journey and the generated downloads report their own events.

## Where the data goes

Report suite **`acsmarketingdealernotification`** (tracking server `acsmarketing.sc.omtrdc.net`), set in
`scripts/analytics-config.js`. Hits go out through AppMeasurement. If `AppMeasurement.js` is not
hosted (the default), the module builds the identical `/b/ss/{suite}/…` request itself. To use the
Web SDK instead, set `edgeConfigId` (a datastream); the variable map does not change.

The suite needs the same schema as `acsmarketingtebg` (below). A single page can send to another
suite with `<meta name="analytics-report-suite-id" content="...">`, and `?analytics-mode=debug`
stops a page from sending anything while still collecting events on `window.adobeDataLayer`.

## The schema it fills

| Event | Name | Fired by |
|---|---|---|
| event1 | Component Impression | a block scrolls into view (once per block per page) |
| event2 | CTA Click | any button or link in the page content, and header or footer links |
| event3 | Download | a PDF or HTML download (see below) |
| event4 | Form Start | the first field a person touches in the Create Draft journey |
| event5 | Form Submit | the draft is saved (create, edit or copy) |
| event6 | Scroll Milestone | 25, 50, 75 and 100 percent, once each per page view |

| Variable | Name | Value on this site |
|---|---|---|
| eVar1 | Template | `home`, `archive`, `preview`, `create-draft`, `access` |
| eVar2 | Locale | `en` |
| eVar3 / prop3 | Component ID | the block name plus its variants, for example `communications` or `communications\|archive` |
| eVar4 / prop4 | Block Name | `communications`, `communication-preview`, `create-draft`, `header`, `footer` … |
| eVar5 | Position | the block's order on the page |
| eVar6 | Section Index | the block's section on the page |
| eVar10 | Link Text | the visible label ("Send to Reviewer", "Download PDF", "Next") |
| eVar11 | Link URL | the link address |
| eVar12 | Download File | the file name, for example `draft-2026….pdf` or `DRAFT-2026….html` |
| eVar13 | Scroll Depth | `25%` … `100%` |
| eVar14 | Form Name | `create-draft`, `edit-draft` or `copy-draft` |
| prop1 | Page Path | the URL path |
| prop10 | Region : Link Type | for example `main:download`, `header:internal` |

## What each user action reports

| Action | Reports |
|---|---|
| Open Home, Archive, Preview, Create Draft | page view; Component Impression for each block |
| Row menu ⋮ and its items (Send to Reviewer, Final Approval, Approve, Archive, Restore, Edit, Copy As New) | CTA Click, Link Text = the label. The ⋮ button reports "Row actions", never the record's title |
| Filters, sort, paging | CTA Click for the buttons (sort, page numbers) |
| Create Draft: first field touched | Form Start, Form Name `create-draft` (`edit-draft`, `copy-draft`) |
| Create Draft: Next, Previous, Preview, Submit | CTA Click, Link Text = the button. The step number rides on the event as `component.attributes.step` |
| Create Draft: saved | Form Submit |
| Create Draft: save failed | `form-error` (in the data layer; it has no Analytics event) |
| Preview: Download PDF, Open PDF in new tab | Download (File = the PDF name) |
| Preview or row menu: Download HTML | CTA Click for the button, and Download for the generated file (File = `<id>.html`) |
| Preview: Open HTML in new tab | CTA Click |

A draft that is started but not submitted is the form abandonment the guide measures
(Form Start without Form Submit).

## Privacy and consent

Events wait in a private queue until analytics consent is granted. Consent is **implied** here,
because this is an internal tool, unless the browser sends Do Not Track or Global Privacy Control,
or the visitor chooses otherwise (`dealerConsent.deny()` in the console, remembered in that browser).
The Parker and 3M sites show a consent banner instead; `scripts/consent.js` is the one file to swap
for that. Link text is taken from visible labels. A control that names a record carries
`data-analytics-label` so the record's title is not reported.

## Checking it

- Open any page with `?analytics-debug=1`, then run `dealerAnalytics.dump()` in the console for a
  table of every event, or `dealerAnalytics.lastHit` for the last request to Analytics.
- `?analytics-mode=debug` forces debug mode on a page even when a suite is set.
- `<meta name="analytics" content="off">` turns it off for one page.

## The live Insights panel

A small **Insights** tab sits at the bottom right of every page. Hover it to peek at the panel,
click it to pin it open (click again, the ×, or Escape to close; Shift+Alt+I toggles it). The panel
is computed in the browser from `window.adobeDataLayer`, so it shows exactly what is being sent: the
event count, the components seen, the most-clicked link, scroll depth and a live feed. It has a
bot-signals section and an invisible-traffic reference that are labelled as roadmap illustrations
(`scripts/signals.js` explains which figures are measured and which are reference data).

- `?insights=0` hides it for the rest of the browser tab; `?insights=1` brings it back, opened.
- `<meta name="insights" content="off">` removes it from one page.
- On a touch screen, tapping the tab opens it; there is no hover.
- The opt-in benchmark section from 3M and Parker is left out: it compares consent banners, and
  consent here is implied.

## Files

`scripts/analytics.js` (instrumentation and data layer), `analytics-config.js` (settings),
`analytics-transport/` (AppMeasurement, Web SDK, debug), `consent.js`, `analytics-events.js`
(how a block reports its own event), `insights.js` and `signals.js` with `styles/insights.css` (the
panel), `delayed.js` (loads it all after the page is interactive).
