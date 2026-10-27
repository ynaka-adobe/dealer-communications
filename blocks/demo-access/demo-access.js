// Access-code entry for guests. The form posts to /auth/code, which the edge function
// serves only on the CDN hostname; on *.aem.page / *.aem.live it posts to AUTH_ORIGIN.

const AUTH_ORIGIN = 'https://dealer-communications.ynaka-adobe.com';
const ERRORS = {
  missing: 'Please enter your access code.',
  invalid: "That code wasn't recognized. Check it and try again.",
  expired: 'That code has expired. Contact your Adobe team for a new one.',
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
  node.append(...children);
  return node;
}

const authBase = () => (window.location.origin === AUTH_ORIGIN ? '' : AUTH_ORIGIN);
const safeReturnTo = (v) => (v && v.startsWith('/') && !v.startsWith('//') ? v : '');

export default function decorate(block) {
  const intro = el('div', { class: 'demo-access-intro' });
  [...block.children].forEach((row) => intro.append(...row.querySelectorAll(':scope > div > *')));
  block.replaceChildren(intro);

  const params = new URLSearchParams(window.location.search);
  const returnTo = safeReturnTo(params.get('returnTo'));
  const error = ERRORS[params.get('error')];

  const input = el('input', {
    type: 'text',
    name: 'code',
    id: 'demo-access-code',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    required: '',
    placeholder: 'e.g. DEMO-ABC123',
  });
  if (error) {
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', 'demo-access-error');
  }
  const form = el(
    'form',
    { class: 'demo-access-form', method: 'post', action: `${authBase()}/auth/code` },
    el('label', { for: 'demo-access-code' }, 'Access code'),
    el('div', { class: 'demo-access-row' }, input, el('button', { type: 'submit' }, 'Continue')),
  );
  if (returnTo) form.append(el('input', { type: 'hidden', name: 'returnTo', value: returnTo }));
  if (error) form.append(el('p', { class: 'demo-access-error', id: 'demo-access-error', role: 'alert' }, error));

  const employee = el(
    'p',
    { class: 'demo-access-employee' },
    'Adobe employee? ',
    el('a', { href: `${authBase()}/auth/login?returnTo=${encodeURIComponent(returnTo || '/')}` }, 'Sign in with Okta'),
  );
  block.append(el('div', { class: 'demo-access-panel' }, form, employee));
}
