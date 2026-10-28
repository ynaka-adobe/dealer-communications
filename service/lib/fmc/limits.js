/*
 * Caps for anonymous draft creation. The demo site lets visitors create drafts without
 * signing in, and each draft writes to AEM Author, so creation is bounded:
 *   - per caller (hashed client address): CLIENT_PER_HOUR per clock hour
 *   - across all anonymous callers: PER_DAY per UTC day
 * Counters live in the state store. They are not atomic, so a burst of parallel requests can
 * overshoot slightly; that is acceptable for a demo cap. Signed-in users are not limited.
 */
const crypto = require('crypto');

const DEFAULTS = { clientPerHour: 5, perDay: 100 };
// saving form steps is far more frequent than creating a draft, so it has its own, larger caps
const SAVE_DEFAULTS = { clientPerHour: 120, perDay: 3000 };

const stamp = (d, len) => d.toISOString().replace(/[-:T]/g, '').slice(0, len);

/**
 * Count one anonymous attempt and say whether it may proceed.
 * @returns {Promise<{ok:true}|{ok:false, scope:'client'|'day', retryAfter:number}>}
 */
async function allowAnonymousCreate(store, client, now = new Date(), limits = {}, scope = 'create') {
  const cap = { ...(scope === 'save' ? SAVE_DEFAULTS : DEFAULTS), ...Object.fromEntries(Object.entries(limits).filter(([, v]) => Number.isFinite(v) && v > 0)) };
  const who = crypto.createHash('sha256').update(String(client || 'unknown')).digest('hex').slice(0, 16);
  const dayKey = `fmc:rl:${scope}:d:${stamp(now, 8)}`;
  const clientKey = `fmc:rl:${scope}:c:${who}:${stamp(now, 10)}`;

  const [day, perClient] = await Promise.all([store.get(dayKey), store.get(clientKey)]);
  const dayN = (day && day.n) || 0;
  const clientN = (perClient && perClient.n) || 0;

  if (clientN >= cap.clientPerHour) return { ok: false, scope: 'client', retryAfter: 3600 - (now.getUTCMinutes() * 60 + now.getUTCSeconds()) };
  if (dayN >= cap.perDay) return { ok: false, scope: 'day', retryAfter: 86400 - (now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds()) };

  await Promise.all([store.put(dayKey, { n: dayN + 1 }), store.put(clientKey, { n: clientN + 1 })]);
  return { ok: true };
}

module.exports = { allowAnonymousCreate, DEFAULTS, SAVE_DEFAULTS };
