/**
 * analytics-events.js — a safe way for any block to report its own event.
 *
 * Blocks import this instead of analytics.js, so a block never depends on analytics being
 * loaded, enabled, or consented to: `trackEvent` never throws and does nothing if analytics is
 * off. The event goes into the same data layer, and the same report suite variables, as the
 * automatic ones (see scripts/analytics.js).
 */

/**
 * @param {string} event `form-start`, `form-submit`, `form-error`, ...
 * @param {Element} block the block the event belongs to
 * @param {object} [payload] e.g. `{ form: { name: 'create-draft' } }`
 */
export default function trackEvent(event, block, payload = {}) {
  import('./analytics.js')
    .then((m) => m.trackBlockEvent(event, block, payload))
    .catch(() => { /* analytics must never break the page */ });
}
