/**
 * analytics-transport/index.js — the swappable transport (adapter) interface.
 *
 * The block-aware instrumentation in scripts/analytics.js never talks to a
 * vendor library. It only ever produces `window.adobeDataLayer` events, and
 * hands them to whatever transport this factory returns. That keeps the
 * centerpiece — zero per-component tagging — completely independent of which
 * Adobe product is actually receiving the data, today or later.
 *
 * A transport is just:
 *   {
 *     name: string,
 *     init(): Promise<boolean>,   // resolve false to decline (never throw)
 *     send(entry): void,          // one data layer event
 *   }
 *
 * Selection happens in analytics-config.js. If the chosen transport fails to
 * initialize for any reason, we fall back to `debug` rather than breaking the
 * page or losing the data layer.
 */

const LOADERS = {
  websdk: () => import('./websdk.js'),
  appmeasurement: () => import('./appmeasurement.js'),
  debug: () => import('./debug.js'),
};

/**
 * Creates and initializes the transport for the resolved config.
 * @param {object} config from getAnalyticsConfig()
 * @returns {Promise<{name: string, send: (entry: object) => void}>}
 */
export default async function createTransport(config) {
  const order = config.mode === 'debug' ? ['debug'] : [config.mode, 'debug'];

  for (let i = 0; i < order.length; i += 1) {
    const mode = order[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      const { default: create } = await LOADERS[mode]();
      const transport = create(config);
      // eslint-disable-next-line no-await-in-loop
      const ok = await transport.init();
      if (ok !== false) return transport;
      // eslint-disable-next-line no-console
      console.warn(`[analytics] transport "${mode}" declined — falling back`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[analytics] transport "${mode}" failed to initialize`, e);
    }
  }

  // Last resort: a no-op so the data layer keeps working regardless.
  return { name: 'none', send: () => {} };
}
