/* eslint-disable @typescript-eslint/no-require-imports */
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'outreach.db');
const db = new Database(dbPath);

const contacts = db
  .prepare(
    `SELECT id, company_name, contact_name, email, status, email_subject, email_strategy, email_body, personalization_points, resume_version, sent_at
     FROM contacts
     WHERE status = 'generated'`
  )
  .all();

console.log('=====================================================');
console.log(`TOTAL GENERATED OUTREACH CONTACTS: ${contacts.length}`);
console.log('=====================================================');

contacts.forEach((c, idx) => {
  console.log(`\n[${idx + 1}] COMPANY: ${c.company_name} | RECIPIENT: ${c.contact_name || 'N/A'}`);
  console.log(`    Strategy: ${c.email_strategy}`);
  console.log(`    Subject : ${c.email_subject}`);
  console.log(`    Resume Version: ${c.resume_version}`);
  console.log(`    Body Snippet:`);
  const lines = c.email_body.split('\n').filter(Boolean);
  console.log(`      "${lines[0]}"`);
  console.log(`      "${lines[1] ? lines[1].slice(0, 100) : ''}..."`);
});

// Calculate bigram Jaccard similarity across all generated bodies
function getBigrams(text) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const set = new Set();
  for (let i = 0; i < words.length - 1; i++) {
    set.add(words[i] + ' ' + words[i + 1]);
  }
  return set;
}

let totalPairs = 0;
let highSimPairs = 0;
let maxSim = 0;

for (let i = 0; i < contacts.length; i++) {
  const setA = getBigrams(contacts[i].email_body);
  for (let j = i + 1; j < contacts.length; j++) {
    const setB = getBigrams(contacts[j].email_body);
    let common = 0;
    for (const b of setA) {
      if (setB.has(b)) common++;
    }
    const union = setA.size + setB.size - common;
    const sim = union > 0 ? common / union : 0;
    if (sim > maxSim) maxSim = sim;
    if (sim >= 0.65) highSimPairs++;
    totalPairs++;
  }
}

console.log('\n=====================================================');
console.log('SIMILARITY & DIVERSITY METRICS (Requirement 16 & 31)');
console.log('=====================================================');
console.log(`Total Pairwise Comparisons: ${totalPairs}`);
console.log(`Max Bigram Similarity: ${(maxSim * 100).toFixed(1)}%`);
console.log(`Pairs Exceeding 65% Threshold: ${highSimPairs}`);

// Verification of Send-Safety: NO EMAILS MUST BE SENT
const sentContacts = db.prepare(`SELECT count(*) as count FROM contacts WHERE status = 'sent' OR sent_at IS NOT NULL`).get().count;
const queuePending = db.prepare(`SELECT count(*) as count FROM outreach_queue WHERE status = 'completed'`).get().count;

console.log('\n=====================================================');
console.log('SEND-SAFETY ENFORCEMENT CHECK');
console.log('=====================================================');
console.log(`Contacts with status = 'sent': ${sentContacts} (MUST BE 0)`);
console.log(`Queue items with status = 'completed': ${queuePending} (MUST BE 0)`);

if (sentContacts === 0 && queuePending === 0) {
  console.log('PASS: SEND-SAFETY FULLY ENFORCED. ZERO EMAILS SENT.');
} else {
  console.error('FAIL: UNEXPECTED SENT RECORDS FOUND!');
  process.exit(1);
}
