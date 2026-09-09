/**
 * Regression & Verification Test Suite for CSV + XLSX Input Architecture
 *
 * Verifies:
 * - Test A: Exact reproduction row with SNo | Name | Email | Title | Company
 *           (SourceFuse Technologies mapped to companyName, Akanksha Puri mapped to contactName)
 * - Test B: Header variants matching field-mapper (Organisation, Full Name, Email Address, Job Title)
 * - Test C: Multiple contacts from same company
 * - Test D: Blank / continuation company rows (reconstructCanonicalContacts forward-fill)
 * - Test E: Invalid email handling
 * - Test F: PDF upload rejection (verifies API rejection error: "Unsupported file type. Only CSV (.csv) and Excel (.xlsx) files are allowed.")
 * - Test G: XLS upload rejection (verifies API rejection error: "Unsupported file type. Only CSV (.csv) and Excel (.xlsx) files are allowed.")
 * - Test H: CSV regression (verifies CSV contacts parsing & processing remains 100% functional)
 * - Test I: Resume PDF upload & parsing (extractPdfText and resume text extraction intact)
 * - Test J: Resume MIME attachment generation (buildMimeMessage with application/pdf)
 * - Test K: Field-shift regression check (asserts companyName !== '1 Akanksha Puri' and matches 'SourceFuse Technologies')
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';
import * as XLSX from 'xlsx';

// Setup isolated test database directory
const TEST_DIR = path.join(
  process.cwd(),
  'data',
  `test-excel-upload-${Date.now()}-${Math.random().toString(36).substring(7)}`
);
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.OUTREACH_DRY_RUN = 'true';

import { getDb } from '../src/db';
import { initializeDatabase } from '../src/db/migrate';
import { batches, contacts } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { processBatchFile } from '../src/lib/pipeline/batch-processor';
import { extractPdfText } from '../src/lib/resume/resume-pdf-extractor';
import { buildMimeMessage } from '../src/lib/gmail/mime-builder';
import { parseExcelWorkbook, parseExcel } from '../src/lib/parsers/excel-parser';

// Helper to create an in-memory XLSX Buffer
function createExcelBuffer(headers: string[], rows: (string | number | null | undefined)[][]): Buffer {
  const wsData = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

async function runTests() {
  console.log('=== VERIFYING CSV + XLSX CONTACT INPUT ARCHITECTURE ===\n');

  // Initialize DB
  initializeDatabase();
  const db = getDb();


  // ──────────────────────────────────────────────────────────────────────────
  // TEST A: Exact Reproduction Row
  // SNo | Name | Email | Title | Company
  // 1   | Akanksha Puri | akanksha.puri@sourcefuse.com | Associate Director HR | SourceFuse Technologies
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test A: Exact Reproduction Row with SNo | Name | Email | Title | Company');
  const reproHeaders = ['SNo', 'Name', 'Email', 'Title', 'Company'];
  const reproRows = [
    [1, 'Akanksha Puri', 'akanksha.puri@sourcefuse.com', 'Associate Director HR', 'SourceFuse Technologies'],
  ];
  const reproBuffer = createExcelBuffer(reproHeaders, reproRows);

  const reproBatchResult = await processBatchFile(reproBuffer, 'reproduction_case.xlsx');
  assert(reproBatchResult.batchId, 'Reproduction batch should process successfully');
  assert.strictEqual(reproBatchResult.totalRecords, 1, 'Total records should be 1');
  assert.strictEqual(reproBatchResult.validRecords, 1, 'Valid records should be 1');

  const reproContacts = db
    .select()
    .from(contacts)
    .where(eq(contacts.batchId, reproBatchResult.batchId))
    .all();

  assert.strictEqual(reproContacts.length, 1, 'Should have inserted exactly 1 contact');
  const reproContact = reproContacts[0];

  assert.strictEqual(reproContact.contactName, 'Akanksha Puri', 'contactName must be "Akanksha Puri"');
  assert.strictEqual(reproContact.companyName, 'SourceFuse Technologies', 'companyName must be "SourceFuse Technologies"');
  assert.strictEqual(reproContact.designation, 'Associate Director HR', 'designation must be "Associate Director HR"');
  assert.strictEqual(reproContact.email, 'akanksha.puri@sourcefuse.com', 'email must be "akanksha.puri@sourcefuse.com"');
  console.log('  -> PASSED: Reproduction row mapped with zero field-shifting.\n');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST B: Header Variants Matching field-mapper
  // Organisation | Full Name | Email Address | Job Title
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test B: Header Variants Matching field-mapper');
  const variantHeaders = ['Organisation', 'Full Name', 'Email Address', 'Job Title'];
  const variantRows = [
    ['Google LLC', 'Sundar Pichai', 'sundar@google.com', 'Chief Executive Officer'],
  ];
  const variantBuffer = createExcelBuffer(variantHeaders, variantRows);

  const variantBatchResult = await processBatchFile(variantBuffer, 'variants.xlsx');
  assert(variantBatchResult.batchId, 'Variant headers batch should process successfully');

  const variantContacts = db
    .select()
    .from(contacts)
    .where(eq(contacts.batchId, variantBatchResult.batchId))
    .all();

  assert.strictEqual(variantContacts.length, 1, 'Should have inserted 1 contact');
  assert.strictEqual(variantContacts[0].companyName, 'Google LLC');
  assert.strictEqual(variantContacts[0].contactName, 'Sundar Pichai');
  assert.strictEqual(variantContacts[0].email, 'sundar@google.com');
  assert.strictEqual(variantContacts[0].designation, 'Chief Executive Officer');
  console.log('  -> PASSED: Header variants mapped correctly.\n');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST C: Multiple Contacts From Same Company
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test C: Multiple Contacts From Same Company');
  const multiHeaders = ['Company', 'Name', 'Email', 'Title'];
  const multiRows = [
    ['Microsoft', 'Satya Nadella', 'satya@microsoft.com', 'CEO'],
    ['Microsoft', 'Amy Hood', 'amy@microsoft.com', 'CFO'],
    ['Microsoft', 'Brad Smith', 'brad@microsoft.com', 'President'],
  ];
  const multiBuffer = createExcelBuffer(multiHeaders, multiRows);

  const multiBatchResult = await processBatchFile(multiBuffer, 'multiple_contacts.xlsx');
  assert(multiBatchResult.batchId, 'Multi contacts batch should process successfully');
  assert.strictEqual(multiBatchResult.totalRecords, 3, 'Total records should be 3');

  const multiContacts = db
    .select()
    .from(contacts)
    .where(eq(contacts.batchId, multiBatchResult.batchId))
    .all();

  assert.strictEqual(multiContacts.length, 3, 'Should have 3 inserted contacts');
  for (const c of multiContacts) {
    assert.strictEqual(c.companyName, 'Microsoft', 'All contacts belong to Microsoft');
  }
  const multiEmails = multiContacts.map((c) => c.email).sort();
  assert.deepStrictEqual(multiEmails, ['amy@microsoft.com', 'brad@microsoft.com', 'satya@microsoft.com']);
  console.log('  -> PASSED: Multiple contacts correctly ingested under single company.\n');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST D: Blank / Continuation Company Rows (reconstructCanonicalContacts forward-fill)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test D: Blank / Continuation Company Rows (Forward-Fill)');
  const continuationHeaders = ['Company', 'Name', 'Email'];
  const continuationRows = [
    ['Apple Inc', 'Tim Cook', 'tim@apple.com'],
    ['', 'Craig Federighi', 'craig@apple.com'],
    ['', 'Eddy Cue', 'eddy@apple.com'],
    ['Amazon', 'Andy Jassy', 'andy@amazon.com'],
    ['', 'Jeff Bezos', 'jeff@amazon.com'],
  ];
  const continuationBuffer = createExcelBuffer(continuationHeaders, continuationRows);

  const continuationBatchResult = await processBatchFile(continuationBuffer, 'continuation.xlsx');
  assert(continuationBatchResult.batchId, 'Continuation batch should process successfully');
  assert.strictEqual(continuationBatchResult.totalRecords, 5, 'Total records should be 5');

  const continuationContacts = db
    .select()
    .from(contacts)
    .where(eq(contacts.batchId, continuationBatchResult.batchId))
    .all();

  assert.strictEqual(continuationContacts.length, 5, 'All 5 contacts ingested');
  const appleContacts = continuationContacts.filter((c) => c.email.endsWith('@apple.com'));
  assert.strictEqual(appleContacts.length, 3, '3 Apple contacts');
  assert(appleContacts.every((c) => c.companyName === 'Apple Inc'), 'Apple forward-filled to blank company rows');

  const amazonContacts = continuationContacts.filter((c) => c.email.endsWith('@amazon.com'));
  assert.strictEqual(amazonContacts.length, 2, '2 Amazon contacts');
  assert(amazonContacts.every((c) => c.companyName === 'Amazon'), 'Amazon forward-filled to blank company rows');
  console.log('  -> PASSED: Forward-fill correctly attributes blank company rows.\n');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST E: Invalid Email Handling
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test E: Invalid Email Handling');
  const invalidHeaders = ['Company', 'Name', 'Email'];
  const invalidRows = [
    ['Meta', 'Mark Zuckerberg', 'mark@meta.com'],
    ['Meta', 'Invalid Guy', 'not-a-valid-email'],
    ['Meta', 'Empty Email', ''],
  ];
  const invalidBuffer = createExcelBuffer(invalidHeaders, invalidRows);

  const invalidBatchResult = await processBatchFile(invalidBuffer, 'invalid_emails.xlsx');
  assert(invalidBatchResult.batchId, 'Batch with invalid emails should process successfully');
  assert.strictEqual(invalidBatchResult.totalRecords, 3);
  assert.strictEqual(invalidBatchResult.validRecords, 1);
  assert.strictEqual(invalidBatchResult.invalidEmails, 2);

  const invalidDbContacts = db
    .select()
    .from(contacts)
    .where(eq(contacts.batchId, invalidBatchResult.batchId))
    .all();

  const validRecord = invalidDbContacts.find((c) => c.contactName === 'Mark Zuckerberg');
  assert(validRecord && validRecord.emailValid === true, 'Mark Zuckerberg has valid email');

  const invalidRecords = invalidDbContacts.filter((c) => c.contactName !== 'Mark Zuckerberg');
  assert.strictEqual(invalidRecords.length, 2, '2 invalid records saved');
  assert(invalidRecords.every((c) => c.emailValid === false && c.status === 'skipped'), 'Invalid records flagged and skipped');
  console.log('  -> PASSED: Invalid emails correctly identified and skipped.\n');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST F: PDF Upload Rejection
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test F: PDF Upload Rejection');
  const ALLOWED_EXTENSIONS = ['.csv', '.xlsx'];
  const pdfFilename = 'contacts.pdf';
  const pdfExt = pdfFilename.toLowerCase().slice(pdfFilename.lastIndexOf('.'));
  assert.strictEqual(ALLOWED_EXTENSIONS.includes(pdfExt), false, '.pdf must NOT be in allowed extensions');

  let pdfRejected = false;
  try {
    await processBatchFile(Buffer.from('%PDF-1.4 dummy contacts list'), pdfFilename);
  } catch (err: unknown) {
    pdfRejected = true;
    const msg = (err as Error).message;
    assert(
      msg.includes('Unsupported file type') && msg.includes('Only CSV (.csv) and Excel (.xlsx) files are allowed'),
      `Error message must match expected contract: "${msg}"`
    );
  }
  assert.strictEqual(pdfRejected, true, 'processBatch must reject .pdf contact uploads');
  console.log('  -> PASSED: PDF contact uploads rejected with standard error message.\n');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST G: XLS Upload Rejection
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test G: Legacy XLS Upload Rejection');
  const xlsFilename = 'contacts.xls';
  const xlsExt = xlsFilename.toLowerCase().slice(xlsFilename.lastIndexOf('.'));
  assert.strictEqual(ALLOWED_EXTENSIONS.includes(xlsExt), false, '.xls must NOT be in allowed extensions');

  let xlsRejected = false;
  try {
    await processBatchFile(Buffer.from('dummy xls content'), xlsFilename);
  } catch (err: unknown) {
    xlsRejected = true;
    const msg = (err as Error).message;
    assert(
      msg.includes('Unsupported file type') && msg.includes('Only CSV (.csv) and Excel (.xlsx) files are allowed'),
      `Error message must match expected contract: "${msg}"`
    );
  }
  assert.strictEqual(xlsRejected, true, 'processBatch must reject .xls contact uploads');
  console.log('  -> PASSED: Legacy .xls rejected with standard error message.\n');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST H: CSV Regression
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test H: CSV Regression');
  const csvContent = `Company,Name,Email,Designation
Stripe,Patrick Collison,patrick@stripe.com,CEO
Stripe,John Collison,john@stripe.com,President
`;
  const csvBatchResult = await processBatchFile(Buffer.from(csvContent), 'stripe_team.csv');
  assert(csvBatchResult.batchId, 'CSV batch should process successfully');
  assert.strictEqual(csvBatchResult.totalRecords, 2, 'Total CSV records should be 2');

  const csvDbContacts = db
    .select()
    .from(contacts)
    .where(eq(contacts.batchId, csvBatchResult.batchId))
    .all();

  assert.strictEqual(csvDbContacts.length, 2, '2 contacts inserted from CSV');
  assert(csvDbContacts.every((c) => c.companyName === 'Stripe'), 'Both contacts associated with Stripe');
  console.log('  -> PASSED: Existing CSV processing remains 100% operational.\n');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST I: Resume PDF Upload & Parsing Intact
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test I: Resume PDF Upload & Parsing Intact');
  const sampleResumePath = path.join(__dirname, 'fixtures', 'sample_resume.pdf');
  assert(fs.existsSync(sampleResumePath), 'sample_resume.pdf fixture must exist');

  const sampleResumeBuffer = fs.readFileSync(sampleResumePath);
  const extractedResumeText = await extractPdfText(sampleResumeBuffer);

  assert(extractedResumeText.length > 50, 'extractPdfText must extract resume text');
  assert(
    extractedResumeText.toLowerCase().includes('aditya') ||
      extractedResumeText.toLowerCase().includes('email') ||
      extractedResumeText.toLowerCase().includes('experience'),
    'Extracted resume text must contain candidate details'
  );
  console.log(`  -> PASSED: Resume PDF text extracted successfully (${extractedResumeText.length} chars).\n`);

  // ──────────────────────────────────────────────────────────────────────────
  // TEST J: Resume MIME Attachment Generation (application/pdf)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test J: Resume MIME Attachment Generation (application/pdf)');
  const dummyResumePdfBuffer = Buffer.from('%PDF-1.4 test resume attachment content');
  const rawBase64Mime = buildMimeMessage({
    from: 'aditya@example.com',
    to: 'akanksha.puri@sourcefuse.com',
    subject: 'Application for Senior Software Engineer',
    bodyText: 'Dear Akanksha,\n\nI am writing to express my interest in joining SourceFuse Technologies.\n\nBest regards,\nAditya',
    attachment: {
      filename: 'Aditya_Resume.pdf',
      contentType: 'application/pdf',
      content: dummyResumePdfBuffer,
    },
  });

  // Decode the URL-safe base64 MIME
  const decodedMime = Buffer.from(
    rawBase64Mime.replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  ).toString('utf-8');

  assert(decodedMime.includes('Content-Type: multipart/mixed;'), 'MIME must be multipart/mixed');
  assert(decodedMime.includes('Content-Type: application/pdf; name="Aditya_Resume.pdf"'), 'Attachment must specify application/pdf');
  assert(decodedMime.includes('Content-Disposition: attachment; filename="Aditya_Resume.pdf"'), 'Attachment must specify attachment disposition');
  assert(decodedMime.includes('Content-Transfer-Encoding: base64'), 'Attachment must specify base64 transfer encoding');
  console.log('  -> PASSED: Outbound Gmail MIME message properly attaches PDF resume.\n');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST K: Field-Shift Regression Check
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test K: Field-Shift Regression Check');
  assert.notStrictEqual(
    reproContact.companyName,
    '1 Akanksha Puri',
    'CRITICAL: companyName must NOT be "1 Akanksha Puri"'
  );
  assert.notStrictEqual(
    reproContact.companyName,
    'Akanksha Puri',
    'CRITICAL: companyName must NOT be contact name "Akanksha Puri"'
  );
  assert.strictEqual(
    reproContact.companyName,
    'SourceFuse Technologies',
    'companyName must strictly be "SourceFuse Technologies"'
  );
  assert.strictEqual(
    reproContact.contactName,
    'Akanksha Puri',
    'contactName must strictly be "Akanksha Puri"'
  );
  console.log('  -> PASSED: Field-shift regression completely prevented.\n');

  // Clean up isolated DB directory
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors on Windows
  }

  console.log('====================================================');
  console.log('ALL TESTS A THROUGH K PASSED SUCCESSFULLY!');
  console.log('====================================================');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
