/*
 * Start another action of this app without waiting for it (a non-blocking invoke through the
 * runtime's REST API, using the credentials the runtime gives every action). Rejects when those
 * are not available, so the caller can do the work itself instead.
 */
async function invokeAsync(action, params, env = process.env, fetchImpl = fetch) {
  const key = env.__OW_API_KEY;
  const host = env.__OW_API_HOST;
  const ns = env.__OW_NAMESPACE;
  if (!key || !host || !ns) throw new Error('no runtime credentials to start another action');
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(action)) throw new Error('invalid action name');
  const res = await fetchImpl(`${host}/api/v1/namespaces/${encodeURIComponent(ns)}/actions/${action}?blocking=false`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(key).toString('base64')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  if (res.status !== 202 && res.status !== 200) throw new Error(`could not start ${action} (${res.status})`);
}

module.exports = { invokeAsync };
