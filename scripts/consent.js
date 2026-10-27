/**
 * consent.js — the on-switch for analytics.
 *
 * scripts/analytics.js holds every event in a private queue until analytics consent is granted,
 * then flushes it. The sister sites (Parker, 3M) show a consent banner. This site is an internal
 * communications tool, so consent is IMPLIED unless the visitor has said no:
 *
 *   - denied if the browser sends Do Not Track or Global Privacy Control,
 *   - denied if the visitor chose it (`dealerConsent.deny()`, remembered in this browser),
 *   - granted otherwise.
 *
 * Swap this file for the banner version (see parker/scripts/consent.js) if a customer needs one;
 * nothing else changes, because analytics.js only uses `onConsentChange` and `initConsent`.
 */
const STORAGE_KEY = 'dealer-consent';

const listeners = new Set();
let current = null;

function stored() {
  try { return window.localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
}

/** The categories as they stand now. */
function decide() {
  const choice = stored();
  const privacySignal = window.navigator?.globalPrivacyControl === true
    || window.navigator?.doNotTrack === '1';
  const analytics = choice === 'granted' || (choice !== 'denied' && !privacySignal);
  return { necessary: true, analytics, personalization: false };
}

function publish() {
  current = decide();
  listeners.forEach((fn) => {
    try { fn(current); } catch (e) { /* a listener must not break the page */ }
  });
}

/** Subscribe to consent; the callback also runs at once if consent is already decided. */
export function onConsentChange(fn) {
  listeners.add(fn);
  if (current) fn(current);
  return () => listeners.delete(fn);
}

/** Decide consent and tell the listeners. Called once, from delayed.js. */
export function initConsent() {
  publish();
  window.dealerConsent = {
    get categories() { return current; },
    grant() { try { window.localStorage.setItem(STORAGE_KEY, 'granted'); } catch (e) { /* ignore */ } publish(); },
    deny() { try { window.localStorage.setItem(STORAGE_KEY, 'denied'); } catch (e) { /* ignore */ } publish(); },
  };
}
