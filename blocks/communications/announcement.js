import { ANNOUNCEMENT } from './communications-data.js';

/** Opens the Announcement dialog; resolves true on Create, false on Cancel/close. */
export default function showAnnouncement() {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'announcement';
    dialog.setAttribute('aria-labelledby', 'announcement-title');
    const link = ANNOUNCEMENT.ticketUrl;
    dialog.innerHTML = `
      <div class="announcement-head">
        <h2 id="announcement-title"></h2>
        <button type="button" class="announcement-x" aria-label="Close">\u2715</button>
      </div>
      <div class="announcement-body">
        <p class="announcement-message"></p>
        <p><span class="announcement-ticket-text"></span> <a class="announcement-ticket" target="_blank" rel="noopener"></a></p>
      </div>
      <div class="announcement-foot">
        <button type="button" class="announcement-cancel">\u2715 Cancel</button>
        <button type="button" class="announcement-create">\u2713 Create</button>
      </div>`;
    dialog.querySelector('h2').textContent = ANNOUNCEMENT.title;
    dialog.querySelector('.announcement-message').textContent = ANNOUNCEMENT.message;
    dialog.querySelector('.announcement-ticket-text').textContent = ANNOUNCEMENT.ticketText;
    const a = dialog.querySelector('.announcement-ticket');
    a.textContent = ANNOUNCEMENT.ticketLinkText;
    a.href = link;
    let result = false;
    dialog.querySelector('.announcement-create').addEventListener('click', () => { result = true; dialog.close(); });
    dialog.querySelector('.announcement-cancel').addEventListener('click', () => dialog.close());
    dialog.querySelector('.announcement-x').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('.announcement-create').focus();
  });
}
