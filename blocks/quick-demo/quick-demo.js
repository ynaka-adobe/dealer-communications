import { createDraft, getStatus, reviewCommunication } from '../../scripts/communications-api.js';
import trackEvent from '../../scripts/analytics-events.js';

const MAX = 600; // the summary section is limited to 600 characters
const POLL_MS = 3000;
const GIVE_UP_MS = 4 * 60 * 1000;

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** `YYYY-MM-DDTHH:mm`, the local time the service expects for a publish date. */
function nowLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The message as paragraphs; the first line also names the communication. */
function payloadFor(text, pdfStyle) {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const first = lines[0] || 'Demo communication';
  return {
    title: `Demo: ${first.slice(0, 60)}`,
    dealerComm: 'Yes',
    fieldPublish: nowLocal(),
    dealerGroup: 'All Dealers',
    originator: 'demo',
    pdfStyle,
    summary: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join(''),
    action: '<p>Read the message and share it with your team.</p>',
    questions: '<p>Contact your field representative with any questions.</p>',
  };
}

/** Waits for the hosted PDF to answer, then resolves with its address. */
async function pdfReady(id) {
  const url = `/pdfs/${id.toLowerCase()}.pdf`;
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await fetch(`${url}?nc=${Date.now()}`, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
    if (r && r.ok) return url;
    // eslint-disable-next-line no-await-in-loop
    await wait(2000);
  }
  throw new Error('The PDF was made but is not available yet. Try again in a moment.');
}

export default function decorate(block) {
  // inside another page (an iframe): no site header or footer
  if (new URLSearchParams(window.location.search).has('embed')) document.body.classList.add('quick-demo-embed');
  block.textContent = '';

  const form = el('div', 'quick-demo-form');
  const label = el('label', 'quick-demo-label', 'Write your communication');
  label.htmlFor = 'quick-demo-text';
  const text = el('textarea', 'quick-demo-text');
  text.id = 'quick-demo-text';
  text.maxLength = MAX;
  text.rows = 9;
  text.placeholder = 'For example: Service bulletin. All dealers should complete the new inspection by Friday.';
  const count = el('p', 'quick-demo-count', `0 / ${MAX}`);
  const styleLabel = el('label', 'quick-demo-label', 'PDF style');
  styleLabel.htmlFor = 'quick-demo-style';
  const style = el('select', 'quick-demo-style');
  style.id = 'quick-demo-style';
  [['dealer', 'Dealer Communications'], ['adobe', 'Adobe']].forEach(([v, t]) => style.append(new Option(t, v)));
  const button = el('button', 'quick-demo-button', 'Generate PDF');
  button.type = 'button';
  button.disabled = true;
  const status = el('p', 'quick-demo-status');
  status.setAttribute('role', 'status');
  form.append(label, text, count, styleLabel, style, button, status);

  const view = el('div', 'quick-demo-view');
  const empty = el('p', 'quick-demo-empty', 'Your PDF will appear here when it is ready.');
  view.append(empty);

  block.append(form, view);

  text.addEventListener('input', () => {
    count.textContent = `${text.value.length} / ${MAX}`;
    button.disabled = !text.value.trim();
  });

  const say = (message, kind = '') => { status.textContent = message; status.dataset.kind = kind; };

  button.addEventListener('click', async () => {
    button.disabled = true;
    text.disabled = true;
    style.disabled = true;
    view.textContent = '';
    view.append(empty);
    trackEvent('form-start', block, { form: { name: 'quick-demo' } });
    try {
      say('Saving your communication…');
      const created = await createDraft(payloadFor(text.value, style.value));
      say('Asking AEM Guides to generate the PDF…');
      await reviewCommunication(created.id, 'approve', '');
      const started = Date.now();
      let current = '';
      while (current !== 'PUBLISHED') {
        if (Date.now() - started > GIVE_UP_MS) throw new Error('The PDF is taking longer than expected. Check the list on the Dealer Communications site.');
        // eslint-disable-next-line no-await-in-loop
        await wait(POLL_MS);
        // eslint-disable-next-line no-await-in-loop
        const s = await getStatus(created.id).catch(() => null);
        current = s ? s.status : current;
        if (current === 'PDF ERROR') throw new Error('The PDF could not be generated.');
        say(`Generating the PDF… (${Math.round((Date.now() - started) / 1000)}s)`);
      }
      const url = await pdfReady(created.id);
      const frame = el('iframe', 'quick-demo-pdf');
      frame.src = url;
      frame.title = 'Generated PDF';
      view.textContent = '';
      view.append(frame);
      say('Your PDF is ready.', 'ok');
      trackEvent('form-submit', block, { form: { name: 'quick-demo' } });
    } catch (e) {
      say(e.message || 'Something went wrong. Please try again.', 'error');
      trackEvent('form-error', block, { form: { name: 'quick-demo' } });
    } finally {
      button.disabled = !text.value.trim();
      text.disabled = false;
      style.disabled = false;
    }
  });
}
