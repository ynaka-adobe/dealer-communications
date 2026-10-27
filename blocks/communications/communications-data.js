/*
 * Data source for the communications widget.
 * Replace getCommunications() with a fetch() to the real API when available.
 */
const SAMPLE = [
  {
    title: 'TestOct21 2 PM', status: 'FINAL APPROVAL PENDING', reviewer: 'sgorle1', author: 'sgorle1', created: '2026-10-21T14:01:26', modified: '2026-10-21T14:03:57',
  },
  {
    title: 'EFC Test Oct 21', status: 'DRAFT', reviewer: 'mshanm26', author: 'sgorle1', created: '2026-10-21T10:30:57', modified: '2026-10-21T10:31:49',
  },
  {
    title: 'Sirisha-Test-EFC', status: 'REVIEWER PENDING', reviewer: 'ndolloff', author: 'sgorle1', created: '2026-10-20T22:43:48', modified: '2026-10-20T23:02:20',
  },
];

const ARCHIVE = [
  ['EFC260061', 'EFC260061-S1 Host an event and build awareness for a local non-profit organization', 'PUBLISHED', 'vck', 'vck', '2026-06-01T06:09:41', true],
  ['EFC260064', 'EFC260064 Demo Communication', 'UNPUBLISH', 'vck', 'vck', '2026-06-01T12:40:53', false],
  ['EFC260060', 'EFC260060-S1 Summer of Community Impact Registration', 'PUBLISHED', 'vck', 'vck', '2026-06-01T12:56:08', false],
  ['EFC260066', 'EFC260066-S1 test', 'PUBLISHED', 'sraja25', 'sraja25', '2026-09-11T05:58:13', false],
  ['EFC260067', 'EFC260067-S2 Spring Upgrade - Test - supersede', 'PUBLISHED', 'kvikran2', 'kvikran2', '2026-09-16T09:39:51', false],
  ['MC260017', 'Test - kvikran2', 'PUBLISHED', 'kvikran2', 'kvikran2', '2026-09-17T09:25:14', false],
  ['EFC260068', 'EFC260068-S2 Communication Test-supersede to simple', 'PUBLISHED', 'kvikran2', 'kvikran2', '2026-09-18T10:15:47', false],
  ['EFC260069', 'EFC260069-S2 Dev Test - Supersede', 'PUBLISHED', 'kvikran2', 'kvikran2', '2026-09-18T11:52:58', false],
  ['EFC260070', 'EFC260070 Test iN Local', 'PUBLISHED', 'kvikran2', 'kvikran2', '2026-09-24T11:20:54', true],
  ['EFC260071', 'EFC260071 Defect 500 test', 'PUBLISHED', 'kvikran2', 'kvikran2', '2026-09-24T18:26:49', true],
].map(([fileName, title, status, reviewer, author, created, locked]) => ({
  fileName, title, status, reviewer, author, created, locked,
}));

/** @param {string} [type] 'archive' for archived communications, else the active list */
export default async function getCommunications(type) {
  if (type === 'archive') return ARCHIVE;
  // drafts created in this browser session (see create-draft-data.js) show first
  let drafts = [];
  try {
    drafts = JSON.parse(sessionStorage.getItem('dealer-drafts') || '[]');
  } catch (e) { /* storage unavailable */ }
  return [...drafts, ...SAMPLE];
}

/*
 * Optional reminder shown when Create Draft is pressed. The criteria for showing it
 * are still TBD, so shouldShowAnnouncement() always returns the `enabled` flag.
 */
export const ANNOUNCEMENT = {
  enabled: true,
  title: 'ANNOUNCEMENT',
  message: 'Please create to continue creating your communication type',
  ticketText: 'If you need a special audience or mail merge',
  ticketLinkText: 'click here to submit a ticket',
  ticketUrl: '#',
};

export function shouldShowAnnouncement() {
  return ANNOUNCEMENT.enabled;
}

/*
 * Detail for the preview page (/preview?file=<fileName>): metadata fields plus the
 * document body. In production this would be the HTML export of the AEM asset.
 * Body markup here is trusted sample content; sanitize any real export before rendering.
 */
const DETAILS = {
  EFC260061: {
    fields: [
      ['Field Publish Date', 'May 5, 2026'],
      ['Target Field Group', 'All Summit Field Personnel'],
      ['Field Lead', 'FSD and SalesOps Market Area Trainer'],
      ['Field Support', 'Office Operations Specialist'],
      ['Target Department', 'Service, Summit Blue Advantage/Crestline CPO/Use, New Sales'],
    ],
    title: 'EFC260061-S1 Host an event and build awareness for a local non-profit organization',
    body: `
      <h2>Action Requested</h2>
      <p>Building on 12 years of community commitment and the momentum of our Summit Building Together initiative, we\u2019re excited to kick off the 2026 Summer of Community Impact. This year, we proudly continue our work with the American Red Cross, Feeding America, Habitat for Humanity, and Team Rubicon, and we welcome World Central Kitchen as our fifth Summit Building Together partner.</p>
      <h2>Summary</h2>
      <p>Beginning in June, you have a unique opportunity to contribute to the building or rebuilding of your local community. We invite you to collaborate with one of our five Summit Building Together partners or a trusted local organization of your choice that focuses on Community Development, Disaster Relief or Skill-based Technical Education. By participating, you\u2019ll be part of a nationwide initiative dedicated to giving back and building meaningful relationships in the communities we serve.</p>
      <h2>Questions</h2>
      <p><strong>Host a community event within your Dealership\u2019s PMA with one of our five Summit Building Together Partners.</strong> You will work with local chapter representatives to host the event of your choosing. There are a limited number of events based on partner resources and geographic locations. They are available on a first-come, first-serve basis.</p>
      <ul>
        <li>American Red Cross \u2013 Host a blood drive or CPR/AED Certification</li>
        <li>Feeding America \u2013 Host a food drive or a volunteer day at a food bank</li>
        <li>Habitat for Humanity \u2013 Host a materials donation drive to benefit a local ReStore location or participate in a Home Build</li>
        <li>Team Rubicon \u2013 Host a disaster preparedness seminar</li>
        <li>World Central Kitchen \u2013 Build mission awareness with a chef recruitment event</li>
      </ul>`,
  },
};

export async function getCommunicationDetail(fileName) {
  return DETAILS[String(fileName || '').toUpperCase()] || null;
}
