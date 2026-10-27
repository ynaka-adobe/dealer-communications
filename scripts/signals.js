/**
 * signals.js — roadmap preview surface for the insights panel.
 *
 * ⚠️ READ THIS BEFORE DEMOING ⚠️
 *
 * This module illustrates two features that are on Adobe's Customer Journey
 * Analytics roadmap and are NOT generally available:
 *
 *   - Enhanced Bot Detection  (beta end of Sept, GA Q1 2027)
 *   - CDN Log Ingestion       (CJA only, GA Q1 2027)
 *
 * Nothing here calls an Adobe API, and nothing here is Adobe's actual
 * implementation. The split below is deliberate and must be preserved, because
 * the honesty of the demo depends on it:
 *
 *   MEASURED    — the bot score, reasons and confidence are computed in this
 *                 browser, right now, from real `navigator` / `screen` /
 *                 interaction signals. They genuinely respond to the visitor.
 *                 They are a *simplified analogue* of the real feature, not a
 *                 preview of Adobe's scoring model.
 *
 *   ILLUSTRATIVE — the invisible-traffic share and the opt-in benchmark
 *                 distribution are fixed reference figures from the Adobe
 *                 decks. They are NOT measured from this site, this session,
 *                 or any CDN log. They are labelled as such in the UI.
 *
 * Every figure rendered from this module carries a provenance label so a
 * presenter cannot accidentally overstate what is live.
 */

/* ─────────────────────── illustrative reference data ───────────────────── */

/**
 * Industry opt-in rate distribution, from the Adobe POV deck "Maximizing Data
 * Value Under Modern Privacy Regulations". Share of organisations falling in
 * each opt-in band. Reference data — not measured here.
 */
export const OPT_IN_BENCHMARK = [
  { band: '21–40%', share: 17 },
  { band: '41–60%', share: 42 },
  { band: '61–80%', share: 35 },
  { band: '81–100%', share: 7 },
];

/** The band most large enterprises fall into, per the same deck. */
export const OPT_IN_ENTERPRISE_RANGE = '41–80%';

/**
 * Illustrative share of traffic that never reaches Web SDK — bots, AI agents
 * and non-consented visits — which CDN Log Ingestion is designed to surface.
 * A fixed reference figure for the demo, NOT a measurement of this site.
 */
export const INVISIBLE_TRAFFIC_SHARE = 38;

/* ──────────────────────── measured client signals ──────────────────────── */

/** How long a visitor may sit without moving the pointer before it looks odd. */
const POINTER_IDLE_MS = 5000;

/**
 * Weighted heuristics. Each returns a reason string when it fires. Weights are
 * deliberately modest so no single soft signal can brand a real visitor a bot;
 * only `navigator.webdriver` is near-conclusive on its own.
 */
const HEURISTICS = [
  {
    id: 'webdriver',
    weight: 45,
    hard: true,
    test: () => navigator.webdriver === true,
    reason: 'Browser reports navigator.webdriver — it is under automation control',
  },
  {
    id: 'plugins',
    weight: 15,
    test: () => navigator.plugins?.length === 0,
    reason: 'No browser plugins registered, typical of a headless runtime',
  },
  {
    id: 'screen',
    weight: 15,
    test: () => !window.screen?.width || !window.screen?.height
      || window.screen.width < 400 || window.screen.height < 400,
    reason: 'Screen dimensions are missing or implausibly small for a real display',
  },
  {
    id: 'languages',
    weight: 15,
    test: () => !navigator.languages || navigator.languages.length === 0,
    reason: 'No language preferences advertised by the browser',
  },
  {
    id: 'no-pointer',
    weight: 20,
    // Recency, not a lifetime total. A visitor has to move the mouse to click
    // the consent banner, so a cumulative "never moved" counter is spent after
    // the first click and can never fire again — which is exactly the idle
    // visitor this check exists to catch.
    test: (o) => o.pointerIdleMs > POINTER_IDLE_MS,
    reason: 'No pointer movement recorded in the last 5 seconds',
  },
  {
    id: 'metronomic',
    weight: 15,
    test: (o) => o.cadenceVariance !== null && o.cadenceVariance < 0.02,
    reason: 'Interaction cadence is near-perfectly regular, suggesting a script',
  },
];

/** Passive observation state. Listeners are passive and never block input. */
const observed = {
  startedAt: Date.now(),
  lastPointerMoveAt: null,
  gaps: [],
  lastInteraction: null,
};

let listening = false;

function noteInteraction() {
  const now = Date.now();
  if (observed.lastInteraction !== null) {
    observed.gaps.push(now - observed.lastInteraction);
    if (observed.gaps.length > 12) observed.gaps.shift();
  }
  observed.lastInteraction = now;
}

/**
 * Starts passive observation. Safe to call more than once. Deliberately cheap:
 * counters only, no event objects retained, all listeners passive.
 */
export function observeSignals() {
  if (listening) return;
  listening = true;
  window.addEventListener('pointermove', () => {
    observed.lastPointerMoveAt = Date.now();
  }, { passive: true });
  // Cadence deliberately excludes pointermove: the browser emits it at a near
  // fixed sampling rate, so including it would make every human look scripted.
  window.addEventListener('scroll', noteInteraction, { passive: true });
  window.addEventListener('keydown', noteInteraction, { passive: true });
  window.addEventListener('click', noteInteraction, { passive: true });
}

/**
 * Coefficient of variation across recent interaction gaps. A human produces a
 * noisy series; a scripted driver on a fixed interval produces a flat one.
 * @returns {number|null} null until there are enough samples to mean anything
 */
function cadenceVariance() {
  const { gaps } = observed;
  if (gaps.length < 4) return null;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (!mean) return null;
  const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
  return Math.sqrt(variance) / mean;
}

/**
 * Evaluates every heuristic against the live browser and returns a bot
 * assessment. Recomputed on each render, so it visibly responds as the
 * presenter moves the mouse or scrolls.
 *
 * @returns {{score: number, reasons: string[], confidence: string,
 *            verdict: string, checked: number}}
 */
export function assessBot() {
  const now = Date.now();
  const ctx = {
    elapsed: now - observed.startedAt,
    // Time since the last pointer movement, or since load if there has never
    // been one. Lets the check re-arm whenever the visitor goes quiet again.
    pointerIdleMs: now - (observed.lastPointerMoveAt ?? observed.startedAt),
    cadenceVariance: cadenceVariance(),
  };

  const fired = HEURISTICS.filter((h) => {
    try {
      return h.test(ctx) === true;
    } catch (e) {
      return false;
    }
  });

  const score = Math.min(100, fired.reduce((sum, h) => sum + h.weight, 0));

  // Confidence describes how much we trust the score, which is not the same as
  // how high it is: one hard signal, or several corroborating soft ones, is a
  // confident read. A single soft signal on its own is not.
  let confidence = 'Low';
  if (fired.some((h) => h.hard) || fired.length >= 3) confidence = 'High';
  else if (fired.length === 2) confidence = 'Medium';
  else if (fired.length === 0 && ctx.elapsed > 5000) confidence = 'Medium';

  let verdict = 'Human';
  if (score >= 60) verdict = 'Likely automated';
  else if (score >= 30) verdict = 'Suspicious';

  return {
    score,
    confidence,
    verdict,
    checked: HEURISTICS.length,
    reasons: fired.map((h) => h.reason),
  };
}

/**
 * This session's consent position, expressed the way the opt-in benchmark is,
 * so the two can be read side by side.
 * @param {object|null} categories from getConsent()
 * @returns {{label: string, granted: number, total: number}}
 */
export function consentPosture(categories) {
  if (!categories) return { label: 'No decision yet', granted: 0, total: 2 };
  const optional = ['analytics', 'personalization'];
  const granted = optional.filter((id) => categories[id] === true).length;
  const labels = ['Opted out of everything optional', 'Partial opt-in', 'Full opt-in'];
  return { label: labels[granted], granted, total: optional.length };
}
