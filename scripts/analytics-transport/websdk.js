/**
 * analytics-transport/websdk.js — Adobe Web SDK (alloy) transport, ANALYTICS ONLY.
 *
 * Selected only when a datastream ID is configured in analytics-config.js. The
 * customer has no datastream today, so this path is built and ready but dormant;
 * pasting `edgeConfigId` is the only step needed to switch onto it.
 *
 * ── Coexistence with at.js (important) ────────────────────────────────────
 * This site already runs Adobe Target on at.js 2.11.8 (scripts/target.js), and
 * that integration is deliberately left untouched. Running alloy alongside at.js
 * on the same page risks two identity stacks minting two different ECIDs, which
 * would split visitor counts between Analytics and Target.
 *
 * We defend against that in two ways:
 *   • `idMigrationEnabled: true` — alloy reads/writes the legacy `AMCV_` cookie,
 *     so it adopts the ECID that at.js / the Visitor API already established
 *     rather than generating a competing one.
 *   • personalization is fully disabled — no `renderDecisions`, no decision
 *     scopes, and `personalizationStorageEnabled: false`. alloy never fetches or
 *     renders an offer, so it cannot fight at.js over the DOM or profile state.
 *     Target remains 100% at.js.
 *
 * TRADEOFF, stated plainly: this is a transitional, two-library setup. It is the
 * right call for a demo timeline and for a phased migration, but the end-state
 * recommendation is to retire at.js and let alloy serve both Analytics and
 * Target from a single request. That consolidation is explicitly out of scope.
 */

/* alloy's own loader requires the `__alloyNS` global — the underscores are theirs. */
/* eslint-disable no-underscore-dangle */

const XDM_EVENT_TYPES = {
  'page-view': 'web.webpagedetails.pageViews',
  'block-view': 'web.webinteraction.impression',
  'cta-click': 'web.webinteraction.linkClicks',
  'navigation-click': 'web.webinteraction.linkClicks',
  'download-click': 'web.webinteraction.linkClicks',
  'scroll-depth': 'web.webinteraction.other',
  'form-view': 'web.webinteraction.impression',
  'form-start': 'web.formFilledOut',
  'form-submit': 'web.formFilledOut',
};

const LINK_TYPES = { internal: 'other', external: 'exit', download: 'download' };

/**
 * Maps a data layer entry to an XDM ExperienceEvent. Kept in one place so an
 * Analytics practitioner can review and adjust the mapping in isolation.
 * @param {object} entry
 */
export function toXdm(entry) {
  const {
    event, page = {}, component, link, download, scroll, form,
  } = entry;

  const xdm = {
    eventType: XDM_EVENT_TYPES[event] || 'web.webinteraction.other',
    timestamp: entry.eventInfo?.timestamp,
    web: {
      webPageDetails: {
        name: page.name,
        URL: page.url,
        siteSection: page.siteSection,
        server: window.location.hostname,
        ...(event === 'page-view' ? { pageViews: { value: 1 } } : {}),
      },
    },
    _experience: {
      analytics: {
        customDimensions: {
          eVars: {
            eVar1: page.template,
            eVar2: page.locale,
            ...(component ? { eVar3: component.id, eVar4: String(component.position) } : {}),
          },
        },
      },
    },
  };

  if (link || download) {
    xdm.web.webInteraction = {
      name: link?.text || download?.fileName || event,
      URL: link?.href || '',
      type: LINK_TYPES[link?.type] || 'other',
      linkClicks: { value: 1 },
    };
  }
  if (event === 'block-view' || event === 'form-view') {
    xdm.web.webInteraction = { name: `impression:${component?.id || 'unknown'}`, type: 'other' };
  }
  if (scroll) {
    xdm.web.webInteraction = { name: `scroll:${scroll.depth}`, type: 'other' };
  }

  // Non-XDM companion data, available to the datastream as `data`.
  const data = {
    eventName: event,
    page,
    ...(component ? { component } : {}),
    ...(scroll ? { scroll } : {}),
    ...(form ? { form } : {}),
    ...(download ? { download } : {}),
  };

  return { xdm, data };
}

/**
 * Installs the standard alloy base snippet, then loads the library from the
 * Adobe CDN. No npm dependency, no build step.
 * @param {string} name global instance name
 * @param {string} url
 */
function installAlloy(name, url) {
  if (window[name]) return Promise.resolve();
  window.__alloyNS = window.__alloyNS || [];
  window.__alloyNS.push(name);
  window[name] = function alloyQueue(...args) {
    return new Promise((resolve, reject) => {
      window.setTimeout(() => {
        window[name].q.push([resolve, reject, args]);
      });
    });
  };
  window[name].q = [];

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.async = true;
    script.src = url;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`[analytics] failed to load alloy from ${url}`));
    document.head.append(script);
  });
}

/**
 * @param {object} config
 * @returns {{name: string, init: () => Promise<boolean>, send: (e: object) => void}}
 */
export default function createWebSdkTransport(config) {
  let alloy = null;

  return {
    name: 'websdk',

    async init() {
      const {
        instanceName, alloyUrl, edgeConfigId, orgId,
      } = config;
      if (!edgeConfigId || !orgId) {
        // eslint-disable-next-line no-console
        console.warn('[analytics] websdk: edgeConfigId / orgId not configured');
        return false;
      }

      await installAlloy(instanceName, alloyUrl);
      alloy = window[instanceName];

      await alloy('configure', {
        datastreamId: edgeConfigId,
        edgeConfigId,
        orgId,
        defaultConsent: 'in', // we only get here after an explicit opt-in
        idMigrationEnabled: true, // share the legacy AMCV/ECID with at.js
        thirdPartyCookiesEnabled: false,
        personalizationStorageEnabled: false, // analytics-only: Target stays on at.js
        clickCollectionEnabled: false, // we emit our own, block-aware link events
        onBeforeEventSend: (options) => {
          // belt and braces: never let a personalization query slip through
          if (options?.query?.personalization) delete options.query.personalization;
        },
      });
      return true;
    },

    send(entry) {
      if (!alloy || !entry?.event || entry.event === 'consent-update') return;
      alloy('sendEvent', toXdm(entry)).catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[analytics] sendEvent failed', e);
      });
    },
  };
}
