/**
 * Focused CSV Regression Test Suite for Title/Banner Row Detection & "Contact Details" Disambiguation
 *
 * Verifies:
 * 1. Title/Banner Row Detection:
 *    - Row 0: "Employer Contact Details" is ignored as a title/banner row.
 *    - Row 1: "Name of the Company | Name of the HR | Contact Details | Annuaal Package  Rs. Lakhs" becomes actual header.
 * 2. Header Mapping:
 *    - "Name of the Company" -> company_name
 *    - "Name of the HR" -> contact_name
 *    - "Contact Details" -> email (disambiguated via sample email values containing '@')
 *    - "Annuaal Package  Rs. Lakhs" -> IGNORE
 * 3. Exact Email Preservation:
 *    - email value remains exactly "gurunathan.murugan@aspiringminds.in" (no field shifting).
 * 4. Additional Records & Multi-record Parsing:
 *    - Multiple records in the batch parse accurately with no field shifting or package contamination.
 * 5. Ambiguous "Contact Details" with phone numbers:
 *    - When "Contact Details" contains phone numbers and no '@', it is NOT mapped to email.
 * 6. Normal Header-First CSV Files:
 *    - Standard CSV files without title banner continue to parse Row 0 as the header.
 * 7. End-to-End Batch Ingestion via processBatchFile:
 *    - Verifies contacts are ingested with valid non-empty emails, status = 'discovered',
 *      companies queued for classification, and batch starts in status = 'processing'.
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';

// Setup isolated test database directory
const TEST_DIR = path.join(
  process.cwd(),
  'data',
  `test-csv-banner-${Date.now()}-${Math.random().toString(36).substring(7)}`
);
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.OUTREACH_DRY_RUN = 'true';

import { getDb } from '../src/db';
import { initializeDatabase } from '../src/db/migrate';
import { contacts, batches } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { parseCSV } from '../src/lib/parsers/csv-parser';
import { getFieldMapping, applyFieldMapping } from '../src/lib/parsers/field-mapper';
import { processBatchFile } from '../src/lib/pipeline/batch-processor';

async function runTests() {
  console.log('=== VERIFYING CSV TITLE/BANNER DETECTION & CONTACT DETAILS MAPPING ===\n');

  // Initialize DB
  initializeDatabase();
  const db = getDb();

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 1: CSV Parser Unit Level Title/Banner Detection
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test 1: parseCSV ignores title banner and selects multi-column header');
  const csvWithBanner = `Employer Contact Details
Name of the Company,Name of the HR,Contact Details,Annuaal Package  Rs. Lakhs
42 Hertz Software India Private Limited,Mr. Gurunathan,gurunathan.murugan@aspiringminds.in,3.00_6.00
7Eleven Arthashastra India P Ltd,Ms. Aishwarya,placementps@gmail.com,2.50-5.00
Ababil Healthcare Private Limited,,hr@ababilhealthcare.com,1.80-3.00
`;

  const parsed = parseCSV(csvWithBanner);
  assert.strictEqual(parsed.headers.length, 4, 'Headers length must be 4');
  assert.strictEqual(parsed.headers[0], 'Name of the Company', 'Header 0 must be "Name of the Company"');
  assert.strictEqual(parsed.headers[1], 'Name of the HR', 'Header 1 must be "Name of the HR"');
  assert.strictEqual(parsed.headers[2], 'Contact Details', 'Header 2 must be "Contact Details"');
  assert.strictEqual(parsed.headers[3], 'Annuaal Package  Rs. Lakhs', 'Header 3 must be "Annuaal Package  Rs. Lakhs"');
  assert.strictEqual(parsed.rows.length, 3, 'Must parse exactly 3 data rows (skipping banner and header)');

  // Verify row 0 values
  assert.strictEqual(parsed.rows[0]['Name of the Company'], '42 Hertz Software India Private Limited');
  assert.strictEqual(parsed.rows[0]['Name of the HR'], 'Mr. Gurunathan');
  assert.strictEqual(parsed.rows[0]['Contact Details'], 'gurunathan.murugan@aspiringminds.in');
  assert.strictEqual(parsed.rows[0]['Annuaal Package  Rs. Lakhs'], '3.00_6.00');

  console.log('  -> PASSED: Title banner skipped, Row 1 selected as header, data rows parsed cleanly.\n');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 2: Field Mapping for this exact structure
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test 2: getFieldMapping produces expected normalized fields');
  const mapping = await getFieldMapping(parsed.headers, parsed.rows.slice(0, 10));

  assert.strictEqual(mapping['Name of the Company'], 'company_name', '"Name of the Company" -> company_name');
  assert.strictEqual(mapping['Name of the HR'], 'contact_name', '"Name of the HR" -> contact_name');
  assert.strictEqual(mapping['Contact Details'], 'email', '"Contact Details" -> email (disambiguated by sample email values)');
  assert.strictEqual(mapping['Annuaal Package  Rs. Lakhs'], 'IGNORE', '"Annuaal Package  Rs. Lakhs" -> IGNORE');

  const normalized = applyFieldMapping(parsed.rows, mapping);
  assert.strictEqual(normalized.length, 3);
  assert.strictEqual(normalized[0].companyName, '42 Hertz Software India Private Limited');
  assert.strictEqual(normalized[0].contactName, 'Mr. Gurunathan');
  assert.strictEqual(normalized[0].email, 'gurunathan.murugan@aspiringminds.in');
  assert.strictEqual(normalized[1].companyName, '7Eleven Arthashastra India P Ltd');
  assert.strictEqual(normalized[1].contactName, 'Ms. Aishwarya');
  assert.strictEqual(normalized[1].email, 'placementps@gmail.com');
  assert.strictEqual(normalized[2].companyName, 'Ababil Healthcare Private Limited');
  assert.strictEqual(normalized[2].contactName, '');
  assert.strictEqual(normalized[2].email, 'hr@ababilhealthcare.com');

  console.log('  -> PASSED: Field mapping and normalized records produced accurately without shifting.\n');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 3: Ambiguous "Contact Details" with phone numbers (NOT email)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test 3: "Contact Details" with phone numbers is NOT mapped to email');
  const phoneHeaders = ['Company', 'Contact Person', 'Contact Details'];
  const phoneRows = [
    { Company: 'Acme Corp', 'Contact Person': 'Alice Smith', 'Contact Details': '+91 9876543210' },
    { Company: 'Beta LLC', 'Contact Person': 'Bob Jones', 'Contact Details': '011-23456789' },
  ];
  const phoneMapping = await getFieldMapping(phoneHeaders, phoneRows);
  assert.notStrictEqual(phoneMapping['Contact Details'], 'email', '"Contact Details" with phone numbers must NOT map to email');
  console.log('  -> PASSED: Field identification requires "@" in sample values before mapping "Contact Details" to email.\n');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 4: Normal header-first CSV continues to work
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test 4: Normal header-first CSV files continue working');
  const normalCsv = `Company,Name,Email,Designation
Stripe,Patrick Collison,patrick@stripe.com,CEO
Google,Sundar Pichai,sundar@google.com,CEO
`;
  const normalParsed = parseCSV(normalCsv);
  assert.strictEqual(normalParsed.headers.length, 4);
  assert.strictEqual(normalParsed.headers[0], 'Company');
  assert.strictEqual(normalParsed.headers[2], 'Email');
  assert.strictEqual(normalParsed.rows.length, 2);
  assert.strictEqual(normalParsed.rows[0]['Company'], 'Stripe');
  assert.strictEqual(normalParsed.rows[0]['Email'], 'patrick@stripe.com');
  console.log('  -> PASSED: Normal header-first CSV files parse Row 0 as header.\n');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 5: End-to-End Batch Ingestion (processBatchFile) with Title Banner CSV
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test 5: processBatchFile end-to-end with title banner CSV');
  const fullBatchResult = await processBatchFile(Buffer.from(csvWithBanner), '5.2.1_test.csv');

  assert(fullBatchResult.batchId, 'Batch must be created');
  assert.strictEqual(fullBatchResult.totalRecords, 3, 'Total records should be 3 (excluding banner and header)');
  assert.strictEqual(fullBatchResult.validRecords, 3, 'All 3 records have valid non-empty emails');
  assert.strictEqual(fullBatchResult.invalidEmails, 0, 'Zero invalid emails');
  assert.strictEqual(fullBatchResult.status, 'processing', 'Batch with unclassified companies must be in "processing" status');

  const batchRow = db.select().from(batches).where(eq(batches.id, fullBatchResult.batchId)).get();
  assert(batchRow, 'Batch record must exist in DB');
  assert.strictEqual(batchRow.status, 'processing', 'Stored batch status must be "processing"');
  assert.strictEqual(batchRow.totalRecords, 3, 'Stored totalRecords must be 3');
  assert.strictEqual(batchRow.validRecords, 3, 'Stored validRecords must be 3');
  assert.strictEqual(batchRow.invalidEmails, 0, 'Stored invalidEmails must be 0');

  const dbContacts = db
    .select()
    .from(contacts)
    .where(eq(contacts.batchId, fullBatchResult.batchId))
    .all();

  assert.strictEqual(dbContacts.length, 3, 'Must insert exactly 3 contacts');
  const contact1 = dbContacts.find((c) => c.email === 'gurunathan.murugan@aspiringminds.in');
  assert(contact1, 'Contact 1 with email "gurunathan.murugan@aspiringminds.in" must exist');
  assert.strictEqual(contact1.companyName, '42 Hertz Software India Private Limited');
  assert.strictEqual(contact1.contactName, 'Mr. Gurunathan');
  assert.strictEqual(contact1.status, 'discovered');
  assert.strictEqual(contact1.emailValid, true);
  assert.strictEqual(contact1.isDuplicate, false);

  const contact2 = dbContacts.find((c) => c.email === 'placementps@gmail.com');
  assert(contact2, 'Contact 2 with email "placementps@gmail.com" must exist');
  assert.strictEqual(contact2.companyName, '7Eleven Arthashastra India P Ltd');
  assert.strictEqual(contact2.contactName, 'Ms. Aishwarya');

  console.log('  -> PASSED: End-to-end batch ingestion successfully extracts contacts, preserves emails, and sets status to "processing".\n');

  console.log('=== ALL TESTS IN verify-csv-title-banner-and-contact-details.ts PASSED ===\n');

  // Clean up
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
}

runTests().catch((err) => {
  console.error('Test failure:', err);
  process.exit(1);
});
