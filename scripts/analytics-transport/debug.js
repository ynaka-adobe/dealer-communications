/**
 * analytics-transport/debug.js — the zero-credential transport.
 *
 * Always available, needs nothing configured, and never talks to the network.
 * It renders every data layer event as a readable console table, which is what
 * makes the whole instrumentation story demoable today — before a datastream or
 * a report suite exists.
 *
 * It is also the automatic fallback if `websdk` or `appmeasurement` fails to
 * initialize, so the page is never left in a broken state.
 */

const COLUMNS = (entry) => ({
  event: entry.event,
  block: entry.component?.name || '—',
  variants: entry.component?.variants?.join(' ') || '—',
  section: entry.component?.sectionIndex ?? '—',
  position: entry.component?.position ?? '—',
  detail: entry.link?.text
    || entry.download?.fileName
    || entry.form?.name
    || (entry.scroll ? `${entry.scroll.depth}%` : entry.page?.path)
    || '—',
});

/**
 * @param {object} config
 * @returns {{name: string, init: () => Promise<boolean>, send: (e: object) => void}}
 */
export default function createDebugTransport(config) {
  return {
    name: 'debug',

    async init() {
      // eslint-disable-next-line no-console
      console.info(
        '%c[analytics] debug transport active%c — no credentials configured, nothing is sent to Adobe.\n'
        + 'Events land in window.adobeDataLayer. Try dealerAnalytics.dump() for the full table.',
        'color:#d10411;font-weight:700',
        'color:inherit',
      );
      if (config.mode !== 'debug') {
        // eslint-disable-next-line no-console
        console.warn(`[analytics] fell back to debug from "${config.mode}"`);
      }
      return true;
    },

    send(entry) {
      if (!entry?.event) return;
      // eslint-disable-next-line no-console
      console.groupCollapsed(
        `%c▸ ${entry.event}%c ${COLUMNS(entry).block}`,
        'color:#d10411;font-weight:700',
        'color:#888',
      );
      // eslint-disable-next-line no-console
      console.table([COLUMNS(entry)]);
      // eslint-disable-next-line no-console
      console.debug(entry);
      // eslint-disable-next-line no-console
      console.groupEnd();
    },
  };
}
