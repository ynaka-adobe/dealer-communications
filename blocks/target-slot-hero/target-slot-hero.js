// Persona hero slot — personalizes CLIENT-SIDE by calling the Adobe Target
// Delivery API for the `target-slot-hero` mbox and rendering the returned offer.
// (Ported from the Fastly edge function so personalization no longer needs the
// edge; wherever this block is authored on a page, the hero appears.)

const TARGET_CLIENT = 'acsmarketing';
const TARGET_MBOX = 'target-slot-hero';
const ENDPOINT = `https://${TARGET_CLIENT}.tt.omtrdc.net/rest/v1/delivery`;

const PERSONA = {
  1: { color: '#0072ce', color2: '#004a86' },
  2: { color: '#e1261c', color2: '#8f1410' },
  3: { color: '#00884a', color2: '#00542e' },
  4: { color: '#6a1b9a', color2: '#3f0f5c' },
};

// persona/loggedIn/region — head.html exposes window.demoProfile from ?p/cookie;
// fall back to the URL query in case that snippet didn't run.
function getProfile() {
  const d = { ...(window.demoProfile || {}) };
  if (d.persona === undefined) {
    const q = new URLSearchParams(window.location.search);
    const p = q.get('p'); if (p) d.persona = parseInt(p, 10);
    const li = q.get('li'); if (li !== null) d.loggedIn = (li === '1' || li === 'true');
    const r = q.get('region'); if (r) d.region = r.toUpperCase();
  }
  return d;
}

function cookieVal(name) {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : '';
}
function setCookie(name, value) {
  document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=1800;SameSite=Lax`;
}
function randomId() {
  return `${Date.now()}.${Math.random().toString(36).slice(2)}`;
}

function profileParams(profile) {
  return {
    persona: String(profile.persona),
    loggedIn: String(!!profile.loggedIn),
    region: profile.region || '',
  };
}

// Plain offers (DA Experience Fragments) arrive without styling — wrap them in a
// self-contained hero shell using the persona's colors (scoped <style>).
function wrapHero(content, persona) {
  const m = PERSONA[persona] || { color: '#0072ce', color2: '#004a86' };
  const inner = String(content || '')
    .replace(/<div class="metadata">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '').trim();
  return `<section data-persona-hero style="background:linear-gradient(120deg,${m.color},${m.color2});`
    + 'color:#fff;padding:44px 24px;text-align:center;font-family:system-ui,Arial,sans-serif">'
    + '<style>[data-persona-hero]>div{max-width:860px;margin:0 auto}'
    + '[data-persona-hero] p{font-size:16px;line-height:1.5;margin:0 auto 16px;max-width:680px;opacity:.95}'
    + '[data-persona-hero] p:first-child{font:600 12px/1.4 system-ui;letter-spacing:1.5px;'
    + 'text-transform:uppercase;opacity:.85;margin:0 0 12px}'
    + '[data-persona-hero] h1,[data-persona-hero] h2{font-size:32px;line-height:1.15;margin:0 0 12px;font-weight:700}'
    + '[data-persona-hero] a{color:#fff;text-decoration:underline}'
    + `[data-persona-hero] p a{display:inline-block;background:#fff;color:${m.color};font-weight:700;`
    + 'font-size:15px;text-decoration:none;padding:12px 26px;border-radius:4px}'
    + '[data-persona-hero] ul{list-style:none;padding:14px 0 0;margin:22px auto 0;max-width:520px;'
    + 'text-align:left;border-top:1px solid rgba(255,255,255,.25)}'
    + '[data-persona-hero] ul::before{content:"RECOMMENDED READING";display:block;'
    + 'font:600 11px/1.4 system-ui;letter-spacing:1px;opacity:.7;margin-bottom:6px}'
    + '[data-persona-hero] li{margin:4px 0}'
    + '[data-persona-hero] li a{font-size:13px;opacity:.9;display:block}'
    + `</style>${inner}</section>`;
}

// A JSON offer ({token,html} or an array) is parsed; a plain HTML offer (XF) is
// treated as a raw hero to be wrapped.
function normalizeOffers(options) {
  const res = [];
  (options || []).forEach((c) => {
    let val = c;
    if (typeof val === 'string') {
      const s = val.trim();
      if (s[0] === '{' || s[0] === '[') { try { val = JSON.parse(s); } catch (e) { /* html */ } }
      if (typeof val === 'string') { if (s) res.push({ token: 'hero', html: s, raw: true }); return; }
    }
    (Array.isArray(val) ? val : [val]).forEach((o) => {
      if (o && o.token) res.push({ token: String(o.token), html: o.html || o.content || '' });
      else if (typeof o === 'string' && o.trim()) res.push({ token: 'hero', html: o, raw: true });
    });
  });
  return res;
}

async function targetDeliver(profile) {
  const sessionId = cookieVal('mboxSession') || randomId();
  setCookie('mboxSession', sessionId);
  const tntId = cookieVal('mboxTnt');
  const body = {
    context: { channel: 'web', address: { url: `${window.location.origin}${window.location.pathname}` } },
    // Only send id when we have a tntId — an empty id:{} makes Target 400.
    ...(tntId ? { id: { tntId } } : {}),
    experienceCloud: { analytics: { logging: 'server_side' } },
    execute: {
      pageLoad: { profileParameters: profileParams(profile) },
      mboxes: [{ index: 0, name: TARGET_MBOX, profileParameters: profileParams(profile) }],
    },
  };
  const resp = await fetch(`${ENDPOINT}?client=${TARGET_CLIENT}&sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`target ${resp.status}`);
  const data = await resp.json();
  if (data?.id?.tntId) setCookie('mboxTnt', data.id.tntId);
  const opts = [];
  const pageLoad = data?.execute?.pageLoad?.options || [];
  const mboxes = (data?.execute?.mboxes || []).flatMap((m) => m.options || []);
  [...pageLoad, ...mboxes].forEach((o) => { if (o && o.content != null) opts.push(o.content); });
  return opts;
}

export default async function decorate(block) {
  const profile = getProfile();
  if (!profile.persona) return; // no persona → stay empty (CSS hides it)
  try {
    const offers = normalizeOffers(await targetDeliver(profile));
    const hero = offers.find((o) => o.token === 'hero');
    if (hero && hero.html) {
      block.innerHTML = hero.raw ? wrapHero(hero.html, profile.persona) : hero.html;
    }
  } catch (e) { /* fail silently → block stays empty/hidden */ }
}
