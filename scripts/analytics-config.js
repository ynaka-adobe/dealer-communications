/**
 * analytics-config.js — the ONE object to edit to take analytics live.
 *
 * The instrumentation (scripts/analytics.js) is transport-agnostic: it always
 * builds the same clean `window.adobeDataLayer` event stream. What happens to
 * those events underneath is a swappable adapter, chosen by whichever
 * credentials are present:
 *
 *   ┌────────────────┬─────────────────────────────────┬─────────────────────┐
 *   │ mode           │ needs                           │ status              │
 *   ├────────────────┼─────────────────────────────────┼─────────────────────┤
 *   │ websdk         │ edgeConfigId (+ orgId)          │ built, dormant      │
 *   │ appmeasurement │ reportSuiteId + trackingServer  │ ★ ACTIVE — filled   │
 *   │ debug          │ nothing                         │ fallback (always)   │
 *   └────────────────┴─────────────────────────────────┴─────────────────────┘
 *
 * Nothing here is a secret — every value is a public, client-side identifier
 * that ships in page source, so committing them is expected and safe.
 *
 * Any value can also be overridden per page via page metadata, using the same
 * convention as scripts/target.js, e.g.
 *   <meta name="analytics-report-suite-id" content="acsmarketingdealernotification">
 *   <meta name="analytics" content="off">   <!-- disable on a single page -->
 */
import { getMetadata } from './aem.js';

export const ANALYTICS_CONFIG = {
  /* ── mode 1: Web SDK (alloy) → Experience Platform datastream ──────────── */

  /**
   * Adobe datastream ID. PASTE HERE to switch the site onto the Web SDK. ◀──
   * This site has no datastream configured, so this stays empty and the
   * Web SDK is never loaded.
   */
  edgeConfigId: '',

  /** Adobe IMS Org ID — tenant `acsmarketing`. Known, already filled in. */
  orgId: '21BD487E5F2280130A495ECC@AdobeOrg',

  /** Alloy build served from the Adobe CDN (no bundler, no npm dependency). */
  alloyUrl: 'https://cdn1.adoberesources.net/alloy/2.24.0/alloy.min.js',

  /* ── mode 2: AppMeasurement → existing Adobe Analytics / Workspace ─────── */

  /**
   * Adobe Analytics report suite for this site: `acsmarketingdealernotification`, in the same
   * `acsmarketing` org and with the same schema as `acsmarketingtebg` / `acsmarketingparker` (see
   * docs/analytics.md), so the Engagement & Conversion Workspace works on it unchanged.
   * A page can use another suite (for example a dev suite) with
   * `<meta name="analytics-report-suite-id" content="...">`, and `?analytics-mode=debug` keeps a
   * page from sending anything.
   */
  reportSuiteId: 'acsmarketingdealernotification',

  /** Analytics tracking server for the `acsmarketing` org. */
  trackingServer: 'acsmarketing.sc.omtrdc.net',

  /**
   * OPTIONAL. AppMeasurement.js is not on a public CDN — it is generated per
   * customer in Analytics ▸ Admin ▸ Code Manager. If you drop a copy at this
   * path the adapter uses the real `s.t()` / `s.tl()` library; if the file is
   * absent (the case today) it falls back to building the identical
   * `/b/ss/{reportSuite}/…` collection request itself. Reporting is the same
   * either way — see analytics-transport/appmeasurement.js.
   */
  appMeasurementUrl: '',

  /* ── shared ────────────────────────────────────────────────────────────── */

  /** Global alloy instance name. Kept distinct from at.js's `adobe.target`. */
  instanceName: 'alloy',
};

const MODES = ['websdk', 'appmeasurement', 'debug'];

const META_KEYS = {
  edgeConfigId: 'analytics-edge-config-id',
  orgId: 'analytics-org-id',
  alloyUrl: 'analytics-alloy-url',
  reportSuiteId: 'analytics-report-suite-id',
  trackingServer: 'analytics-tracking-server',
  appMeasurementUrl: 'analytics-appmeasurement-url',
};

/**
 * Resolves the effective configuration and picks the transport for this page.
 * Never throws, and never leaves the page without a working mode.
 * @returns {object} config whose `mode` is `websdk`, `appmeasurement` or `debug`
 */
export function getAnalyticsConfig() {
  const config = { ...ANALYTICS_CONFIG };
  Object.entries(META_KEYS).forEach(([key, meta]) => {
    const value = getMetadata(meta)?.trim();
    if (value) config[key] = value;
  });

  // `<meta name="analytics" content="off">` opts a single page out entirely.
  config.enabled = getMetadata('analytics')?.trim().toLowerCase() !== 'off';

  // Explicit override for testing / demoing, e.g. `?analytics-mode=debug`.
  const forced = new URLSearchParams(window.location.search).get('analytics-mode');
  if (forced && MODES.includes(forced)) {
    config.mode = forced;
  } else if (config.edgeConfigId && config.orgId) {
    config.mode = 'websdk';
  } else if (config.reportSuiteId && config.trackingServer) {
    config.mode = 'appmeasurement';
  } else {
    config.mode = 'debug';
  }
  return config;
}

export default getAnalyticsConfig;
