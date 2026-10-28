/*
 * Demo data: realistic communications in every workflow state, created the way a site
 * submission is (AEM topic, preview and map) with dates spread over recent weeks. Every one is
 * marked fmcSeed=demo. The sheet rows are written afterwards by one reconcile run.
 */
const { createDraft } = require('./communications');

const P = (...t) => t.map((x) => `<p>${x}</p>`).join('');
const UL = (...t) => `<ul>${t.map((x) => `<li>${x}</li>`).join('')}</ul>`;

const SEED = [
  // title, status, daysAgo, author, reviewer, division, channel, dealer action, summary
  ['Q4 Service Loyalty Program Update', 'DRAFT', 1, 'sgorle1', 'mshanm26', 'FSD', 'Service', 'Review the updated loyalty tiers before the program opens.', 'Loyalty tiers and redemption rules change for the final quarter.'],
  ['Atlas EV Charging Installation Guidelines', 'DRAFT', 1, 'kvikran2', 'ndolloff', 'Summit Pro', 'Fleet', 'Confirm your service bays meet the new charger requirements.', 'Updated site and electrical requirements for dealer charging equipment.'],
  ['Parts Return Policy Revision', 'DRAFT', 2, 'ndolloff', 'sgorle1', 'FSD', 'Parts', 'Update your returns checklist to the revised window.', 'The core and parts return window changes for stocking orders.'],
  ['Dealer Training Calendar - Winter 2027', 'DRAFT', 2, 'vck', 'mshanm26', 'FSD', 'Training', 'Register your technicians for the winter sessions.', 'New instructor-led and online courses are now open for registration.'],
  ['Voyager EV Software Update 24.3', 'REVIEWER PENDING', 4, 'mshanm26', 'sgorle1', 'Summit Pro', 'Service', 'Apply the update at the next scheduled customer visit.', 'Release notes and installation steps for the 24.3 software package.'],
  ['Warranty Claim Submission Deadline Reminder', 'REVIEWER PENDING', 5, 'sgorle1', 'ndolloff', 'FSD', 'Warranty', 'Submit all open claims before the quarter-end cutoff.', 'Claims received after the cutoff are processed in the next period.'],
  ['Collision Repair Certification Renewal', 'REVIEWER PENDING', 6, 'kvikran2', 'vck', 'FSD', 'Collision', 'Renew your certification before it expires.', 'Renewal steps, required documents and the new fee schedule.'],
  ['Holiday Sales Event Marketing Assets', 'FINAL APPROVAL PENDING', 7, 'vck', 'mshanm26', 'Summit Sales', 'Marketing', 'Download the creative and confirm your event dates.', 'Approved creative, offers copy and co-op guidance for the holiday event.'],
  ['Recall Notice: Brake Line Inspection', 'FINAL APPROVAL PENDING', 8, 'ndolloff', 'sgorle1', 'FSD', 'Safety', 'Begin inspections on affected vehicles immediately.', 'Affected VIN ranges, inspection procedure and the labor time allowance.'],
  ['Service Loaner Vehicle Program Changes', 'FINAL APPROVAL PENDING', 9, 'mshanm26', 'kvikran2', 'FSD', 'Service', 'Review the updated eligibility rules with your service advisors.', 'Loaner eligibility, duration and reimbursement are updated.'],
  ['EV Technician Certification Requirements', 'PUBLISHED', 12, 'sgorle1', 'ndolloff', 'Summit Pro', 'Training', 'Plan certification for your EV technicians.', 'New certification levels required to service high-voltage systems.'],
  ['Customer Satisfaction Survey Results - Q3', 'ARCHIVED', 14, 'kvikran2', 'sgorle1', 'Summit Sales', 'Customer Experience', 'Share the results with your management team.', 'Quarterly survey scores and the top improvement opportunities.'],
  ['Dealer Portal Maintenance Window', 'ARCHIVED', 16, 'vck', 'mshanm26', 'FSD', 'Systems', 'Complete critical orders before the window begins.', 'The portal will be unavailable for scheduled maintenance this weekend.'],
  ['Year-End Inventory Reporting Deadline', 'ARCHIVED', 19, 'ndolloff', 'vck', 'Summit Sales', 'Finance', 'Submit your year-end inventory report on time.', 'Reporting format and the submission deadline for year-end counts.'],
  ['Superseded: 2026 Parts Pricing Schedule', 'UNPUBLISH', 22, 'mshanm26', 'sgorle1', 'FSD', 'Parts', 'Discard the prior schedule; the new one replaces it.', 'This pricing schedule was replaced and is withdrawn.'],
];

const payloadFor = ([title, , , author, reviewer, division, channel, action, summary], when) => ({
  title,
  division,
  channel,
  reviewer,
  alternate: 'ndolloff',
  concurring: 'vck',
  originator: author,
  businessContact: author,
  fieldPublish: new Date(when.getTime() + 3 * 86400000).toISOString().slice(0, 16),
  dealerComm: 'Yes',
  fieldGroup: 'All Summit Field Personnel',
  fieldLead: ['General Manager'],
  dealerGroup: 'All Summit & Crestline Dealers',
  dealerRoles: ['Dealer Principals', 'Service Managers'],
  primaryDept: channel,
  fieldOnly: P('Internal talking points for field staff. Do not share with dealers.'),
  action: P(action),
  summary: P(summary),
  questions: UL('Contact your regional office for details.', 'Submit questions through the dealer support line.'),
});

/** Create entries [from, to) of the seed list; resolves with their ids and statuses. */
async function seedBatch(aem, from, to, now = new Date()) {
  const out = [];
  for (let i = Math.max(0, from); i < Math.min(SEED.length, to); i += 1) {
    const row = SEED[i];
    const when = new Date(now.getTime() - row[2] * 86400000 - i * 3600000);
    // eslint-disable-next-line no-await-in-loop
    const made = await createDraft(aem, payloadFor(row, when), row[3], when, { sheets: null });
    const modified = new Date(when.getTime() + (3 + (i % 5)) * 3600000).toISOString().slice(0, 19);
    // eslint-disable-next-line no-await-in-loop
    await aem.setMetadata(made.assetPath, { fmcStatus: row[1], fmcModified: modified, fmcSeed: 'demo' });
    out.push({ id: made.id, status: row[1], title: row[0] });
  }
  return { count: SEED.length, created: out };
}

module.exports = { seedBatch, SEED };
