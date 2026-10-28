/*
 * A small advisory lock on top of the state store, used so that site saves, AEM events and the
 * scheduled reconcile do not overwrite each other's changes to the sheets.
 *
 * The state store has no compare-and-set, so acquiring is: write our claim, read it back, and
 * proceed only if the claim is still ours. That makes a lost race very unlikely, not impossible;
 * it is a best-effort guard for a demo, backed by the reconcile job repairing any drift. A claim
 * expires on its own, so a crashed holder cannot block the sheets for long.
 */
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createLock(store, { ttlMs = 30000, waitMs = 20000 } = {}) {
  return {
    /** Run fn while holding the named lock; throws 'sheet busy' if it cannot be acquired in time. */
    async withLock(name, fn) {
      const key = `fmc:lock:${name}`;
      const me = crypto.randomBytes(8).toString('hex');
      const deadline = Date.now() + waitMs;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const held = await store.get(key);
        if (!held || held.exp < Date.now()) {
          // eslint-disable-next-line no-await-in-loop
          await store.put(key, { owner: me, exp: Date.now() + ttlMs });
          // eslint-disable-next-line no-await-in-loop
          const check = await store.get(key);
          if (check && check.owner === me) break;
        }
        if (Date.now() >= deadline) throw new Error('sheet busy');
        // eslint-disable-next-line no-await-in-loop
        await sleep(100 + Math.floor(Math.random() * 250));
      }
      try {
        return await fn();
      } finally {
        const still = await store.get(key);
        if (still && still.owner === me) await store.delete(key);
      }
    },
  };
}

module.exports = { createLock };
