/**
 * Safe Contact Generation Recovery Script
 *
 * Resets specific contacts stuck in RETRY_PENDING or GENERATION_FAILED back to PENDING_GENERATION
 * so that the autonomous reconciler can cleanly generate their personalized emails.
 *
 * Target Contacts from Production Investigation:
 * 1. cont_01M1Q66YMC8QFWSAMM4A005Z8H ("BPCL(Bharat Petroleum") - previously failed on unescaped regex '('
 * 2. cont_01M1Q66YMD29Q3N3HXGERB5ZE8 ("Adani Group(For Differently") - hit OpenRouter 429 quota
 *
 * Usage:
 *   npx tsx scripts/recover-stuck-contacts.ts
 */

import { getDb } from '../src/db';
import { contacts } from '../src/db/schema';
import { inArray, sql } from 'drizzle-orm';
import { recoverStuckGenerationContacts } from '../src/lib/pipeline/generation-reconciler';

const TARGET_CONTACT_IDS = [
  'cont_01M1Q66YMC8QFWSAMM4A005Z8H',
  'cont_01M1Q66YMD29Q3N3HXGERB5ZE8',
];

async function main() {
  console.log('================================================================');
  console.log('  RECOVERING STUCK GENERATION CONTACTS');
  console.log('================================================================\n');

  const db = getDb();

  // 1. Inspect current state before recovery
  console.log('--- Current Status Before Recovery ---');
  const preRows = db
    .select({
      id: contacts.id,
      email: contacts.email,
      companyName: contacts.companyName,
      status: contacts.status,
      generationStatus: contacts.generationStatus,
      generationAttemptCount: contacts.generationAttemptCount,
      errorMessage: contacts.errorMessage,
    })
    .from(contacts)
    .where(inArray(contacts.id, TARGET_CONTACT_IDS))
    .all();

  if (preRows.length === 0) {
    console.log('No matching target contact records found in local database.');
    console.log('Target IDs checked:', TARGET_CONTACT_IDS);
  } else {
    for (const r of preRows) {
      console.log(`[Contact] ${r.id}:`);
      console.log(`  Company: ${r.companyName}`);
      console.log(`  Email: ${r.email}`);
      console.log(`  Status: ${r.status}`);
      console.log(`  Generation Status: ${r.generationStatus}`);
      console.log(`  Attempts: ${r.generationAttemptCount}`);
      console.log(`  Error: ${r.errorMessage}`);
    }
  }

  // 2. Perform safe reset
  console.log('\n--- Executing Reset ---');
  const { resetCount, notFoundOrSkipped } = recoverStuckGenerationContacts(TARGET_CONTACT_IDS);
  console.log(`Successfully reset ${resetCount} contact(s) to PENDING_GENERATION.`);

  if (notFoundOrSkipped.length > 0) {
    console.log(`Contacts not found or already generated: ${notFoundOrSkipped.join(', ')}`);
  }

  // 3. Inspect post-recovery state
  console.log('\n--- Status After Recovery ---');
  const postRows = db
    .select({
      id: contacts.id,
      email: contacts.email,
      companyName: contacts.companyName,
      status: contacts.status,
      generationStatus: contacts.generationStatus,
      generationAttemptCount: contacts.generationAttemptCount,
      errorMessage: contacts.errorMessage,
    })
    .from(contacts)
    .where(inArray(contacts.id, TARGET_CONTACT_IDS))
    .all();

  for (const r of postRows) {
    console.log(`[Contact] ${r.id}:`);
    console.log(`  Status: ${r.status} (expected: queued)`);
    console.log(`  Generation Status: ${r.generationStatus} (expected: PENDING_GENERATION)`);
    console.log(`  Attempts: ${r.generationAttemptCount} (expected: 0)`);
    console.log(`  Error: ${r.errorMessage} (expected: null)`);
  }

  console.log('\n================================================================');
  console.log('  RECOVERY SCRIPT EXECUTION COMPLETE');
  console.log('================================================================');
}

main().catch((err) => {
  console.error('Fatal error running recovery script:', err);
  process.exit(1);
});
