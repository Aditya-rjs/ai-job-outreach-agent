import { getDb } from '../src/db';
import { batches, contacts } from '../src/db/schema';
import { sql } from 'drizzle-orm';
import {
  getProcessingPipelineStats,
  getDuplicateCompaniesList,
  getCompanyContactsList,
} from '../src/lib/processing-queries';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`✔ [PASS] ${msg}`);
}

async function runDuplicateCompaniesTestSuite() {
  console.log('======================================================================');
  console.log('DUPLICATE COMPANIES DEFINITION VERIFICATION SUITE');
  console.log('======================================================================\n');

  const db = getDb();
  const now = new Date().toISOString();

  // Test Batch IDs
  const batch1Id = `batch_test_dup_1_${Date.now()}`;
  const batch2Id = `batch_test_dup_2_${Date.now()}`;
  const batch3Id = `batch_test_dup_3_${Date.now()}`;
  const batch4Id = `batch_test_dup_4_${Date.now()}`;
  const batchIsoAId = `batch_test_dup_isoA_${Date.now()}`;
  const batchIsoBId = `batch_test_dup_isoB_${Date.now()}`;
  const batchZeroId = `batch_test_dup_zero_${Date.now()}`;

  // Cleanup any old test fixtures
  db.delete(batches).where(sql`id LIKE 'batch_test_dup_%'`).run();

  try {
    // -------------------------------------------------------------------
    // TEST 1: One contact per company
    // Companies Found = N, Duplicate Companies = 0
    // -------------------------------------------------------------------
    console.log('--- TEST 1: One contact per company ---');
    db.insert(batches).values({
      id: batch1Id,
      filename: 'Batch_Test_1.xlsx',
      uploadDate: now,
      totalRecords: 3,
      validRecords: 3,
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    }).run();

    db.insert(contacts).values([
      {
        id: `c1_1_${Date.now()}`,
        batchId: batch1Id,
        companyName: 'Apple',
        contactName: 'Tim',
        email: 'tim@apple.com',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `c1_2_${Date.now()}`,
        batchId: batch1Id,
        companyName: 'Microsoft',
        contactName: 'Satya',
        email: 'satya@microsoft.com',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `c1_3_${Date.now()}`,
        batchId: batch1Id,
        companyName: 'Amazon',
        contactName: 'Andy',
        email: 'andy@amazon.com',
        createdAt: now,
        updatedAt: now,
      },
    ]).run();

    const stats1 = getProcessingPipelineStats(batch1Id);
    assert(stats1.companiesFound === 3, `Companies Found = 3 (Got: ${stats1.companiesFound})`);
    assert(stats1.duplicateCompanies === 0, `Duplicate Companies = 0 (Got: ${stats1.duplicateCompanies})`);

    const detail1 = getDuplicateCompaniesList({ batchId: batch1Id });
    assert(detail1.total === 0, `Detail total = 0 (Got: ${detail1.total})`);
    assert(detail1.records.length === 0, 'Detail records is empty array');

    // -------------------------------------------------------------------
    // TEST 2: Repeated company (ABC x 2)
    // Duplicate Companies = 1
    // -------------------------------------------------------------------
    console.log('\n--- TEST 2: Repeated company (ABC x 2) ---');
    db.insert(batches).values({
      id: batch2Id,
      filename: 'Batch_Test_2.xlsx',
      uploadDate: now,
      totalRecords: 2,
      validRecords: 2,
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    }).run();

    db.insert(contacts).values([
      {
        id: `c2_1_${Date.now()}`,
        batchId: batch2Id,
        companyName: 'ABC Technologies',
        contactName: 'Alice',
        email: 'alice@abc.com',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `c2_2_${Date.now()}`,
        batchId: batch2Id,
        companyName: 'ABC Technologies',
        contactName: 'Bob',
        email: 'bob@abc.com',
        createdAt: now,
        updatedAt: now,
      },
    ]).run();

    const stats2 = getProcessingPipelineStats(batch2Id);
    assert(stats2.companiesFound === 1, `Companies Found = 1 (Got: ${stats2.companiesFound})`);
    assert(stats2.duplicateCompanies === 1, `Duplicate Companies = 1 (Got: ${stats2.duplicateCompanies})`);

    const detail2 = getDuplicateCompaniesList({ batchId: batch2Id });
    assert(detail2.total === 1, `Detail total = 1 (Got: ${detail2.total})`);
    assert(detail2.records[0].contactCount === 2, `Company ABC has 2 contacts (Got: ${detail2.records[0].contactCount})`);

    // -------------------------------------------------------------------
    // TEST 3: Company appearing 5 times (ABC x 5)
    // Duplicate Companies = 1, NOT 4
    // -------------------------------------------------------------------
    console.log('\n--- TEST 3: Company appearing 5 times (ABC x 5) ---');
    db.insert(batches).values({
      id: batch3Id,
      filename: 'Batch_Test_3.xlsx',
      uploadDate: now,
      totalRecords: 5,
      validRecords: 5,
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    }).run();

    db.insert(contacts).values(
      Array.from({ length: 5 }, (_, i) => ({
        id: `c3_${i}_${Date.now()}`,
        batchId: batch3Id,
        companyName: 'ABC Technologies',
        contactName: `Contact ${i + 1}`,
        email: `contact${i + 1}@abc.com`,
        createdAt: now,
        updatedAt: now,
      }))
    ).run();

    const stats3 = getProcessingPipelineStats(batch3Id);
    assert(stats3.companiesFound === 1, `Companies Found = 1 (Got: ${stats3.companiesFound})`);
    assert(stats3.duplicateCompanies === 1, `Duplicate Companies = 1 (NOT 4) (Got: ${stats3.duplicateCompanies})`);

    const detail3 = getDuplicateCompaniesList({ batchId: batch3Id });
    assert(detail3.total === 1, `Detail total = 1 (Got: ${detail3.total})`);
    assert(detail3.records[0].contactCount === 5, `Company ABC has 5 contacts (Got: ${detail3.records[0].contactCount})`);

    // -------------------------------------------------------------------
    // TEST 4: Multiple repeated companies (ABC x 2, XYZ x 3, Google x 1)
    // Companies Found = 3, Duplicate Companies = 2
    // -------------------------------------------------------------------
    console.log('\n--- TEST 4: Multiple repeated companies (ABC x 2, XYZ x 3, Google x 1) ---');
    db.insert(batches).values({
      id: batch4Id,
      filename: 'Batch_Test_4.xlsx',
      uploadDate: now,
      totalRecords: 6,
      validRecords: 6,
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    }).run();

    db.insert(contacts).values([
      {
        id: `c4_abc1_${Date.now()}`,
        batchId: batch4Id,
        companyName: 'ABC Technologies',
        contactName: 'Contact 1',
        email: 'c1@abc.com',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `c4_abc2_${Date.now()}`,
        batchId: batch4Id,
        companyName: 'ABC Technologies',
        contactName: 'Contact 2',
        email: 'c2@abc.com',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `c4_goog_${Date.now()}`,
        batchId: batch4Id,
        companyName: 'Google',
        contactName: 'Contact 3',
        email: 'c3@google.com',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `c4_xyz1_${Date.now()}`,
        batchId: batch4Id,
        companyName: 'XYZ Ltd',
        contactName: 'Contact 4',
        email: 'c4@xyz.com',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `c4_xyz2_${Date.now()}`,
        batchId: batch4Id,
        companyName: 'XYZ Ltd',
        contactName: 'Contact 5',
        email: 'c5@xyz.com',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `c4_xyz3_${Date.now()}`,
        batchId: batch4Id,
        companyName: 'XYZ Ltd',
        contactName: 'Contact 6',
        email: 'c6@xyz.com',
        createdAt: now,
        updatedAt: now,
      },
    ]).run();

    const stats4 = getProcessingPipelineStats(batch4Id);
    assert(stats4.companiesFound === 3, `Companies Found = 3 (Got: ${stats4.companiesFound})`);
    assert(stats4.duplicateCompanies === 2, `Duplicate Companies = 2 (Got: ${stats4.duplicateCompanies})`);

    const detail4 = getDuplicateCompaniesList({ batchId: batch4Id });
    assert(detail4.total === 2, `Detail total = 2 (Got: ${detail4.total})`);
    const compNames = detail4.records.map((r) => r.companyName);
    assert(
      compNames.includes('XYZ Ltd') && compNames.includes('ABC Technologies'),
      `Duplicate companies contains both repeated companies (Got: ${JSON.stringify(compNames)})`
    );
    assert(!compNames.includes('Google'), 'Google is NOT in duplicate companies (only 1 contact)');

    // -------------------------------------------------------------------
    // TEST 5: Batch Isolation
    // Batch A has ABC x 2 -> Duplicate Companies = 1
    // Batch B has ABC x 1 -> Duplicate Companies = 0
    // -------------------------------------------------------------------
    console.log('\n--- TEST 5: Batch Isolation ---');
    db.insert(batches).values([
      {
        id: batchIsoAId,
        filename: 'Batch_Iso_A.xlsx',
        uploadDate: now,
        totalRecords: 2,
        validRecords: 2,
        status: 'completed',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: batchIsoBId,
        filename: 'Batch_Iso_B.xlsx',
        uploadDate: now,
        totalRecords: 1,
        validRecords: 1,
        status: 'completed',
        createdAt: now,
        updatedAt: now,
      },
    ]).run();

    // Batch A: ABC x 2
    db.insert(contacts).values([
      {
        id: `c_isoA_1_${Date.now()}`,
        batchId: batchIsoAId,
        companyName: 'ABC Technologies',
        contactName: 'Iso A 1',
        email: 'isoa1@abc.com',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `c_isoA_2_${Date.now()}`,
        batchId: batchIsoAId,
        companyName: 'ABC Technologies',
        contactName: 'Iso A 2',
        email: 'isoa2@abc.com',
        createdAt: now,
        updatedAt: now,
      },
    ]).run();

    // Batch B: ABC x 1
    db.insert(contacts).values([
      {
        id: `c_isoB_1_${Date.now()}`,
        batchId: batchIsoBId,
        companyName: 'ABC Technologies',
        contactName: 'Iso B 1',
        email: 'isob1@abc.com',
        createdAt: now,
        updatedAt: now,
      },
    ]).run();

    const statsIsoA = getProcessingPipelineStats(batchIsoAId);
    const statsIsoB = getProcessingPipelineStats(batchIsoBId);
    assert(statsIsoA.duplicateCompanies === 1, `Batch A Duplicate Companies = 1 (Got: ${statsIsoA.duplicateCompanies})`);
    assert(statsIsoB.duplicateCompanies === 0, `Batch B Duplicate Companies = 0 (Got: ${statsIsoB.duplicateCompanies})`);

    // -------------------------------------------------------------------
    // TEST 6: Duplicate Contacts Must Remain a Separate Metric
    // -------------------------------------------------------------------
    console.log('\n--- TEST 6: Duplicate Contacts Remains Separate Metric ---');
    const batchDupContactId = `batch_test_dup_contact_${Date.now()}`;
    db.insert(batches).values({
      id: batchDupContactId,
      filename: 'Batch_Dup_Contacts.xlsx',
      uploadDate: now,
      totalRecords: 3,
      validRecords: 3,
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    }).run();

    db.insert(contacts).values([
      {
        id: `c_dc1_${Date.now()}`,
        batchId: batchDupContactId,
        companyName: 'ABC Technologies',
        contactName: 'John Doe',
        email: 'john@abc.com',
        isDuplicate: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `c_dc2_${Date.now()}`,
        batchId: batchDupContactId,
        companyName: 'ABC Technologies',
        contactName: 'John Doe Duplicate',
        email: 'john@abc.com', // Duplicate contact row
        isDuplicate: true,     // Marked duplicate contact
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `c_dc3_${Date.now()}`,
        batchId: batchDupContactId,
        companyName: 'Unique Inc',
        contactName: 'Unique User',
        email: 'unique@unique.com',
        isDuplicate: false,
        createdAt: now,
        updatedAt: now,
      },
    ]).run();

    const statsDC = getProcessingPipelineStats(batchDupContactId);
    assert(statsDC.duplicateCompanies === 1, `Duplicate Companies = 1 (ABC has 2 contact rows) (Got: ${statsDC.duplicateCompanies})`);
    assert(statsDC.duplicateContacts === 1, `Duplicate Contacts = 1 (is_duplicate = 1) (Got: ${statsDC.duplicateContacts})`);

    // -------------------------------------------------------------------
    // TEST 7: Duplicate-company detail returns repeated companies & their contacts
    // -------------------------------------------------------------------
    console.log('\n--- TEST 7: Detail view returns repeated companies and expandable contacts ---');
    const detail4Check = getDuplicateCompaniesList({ batchId: batch4Id });
    assert(detail4Check.records.length === 2, `Returns 2 duplicate company records (Got: ${detail4Check.records.length})`);
    
    // Check first record
    const recXYZ = detail4Check.records.find((r) => r.companyName === 'XYZ Ltd');
    assert(!!recXYZ, 'Found XYZ Ltd in duplicate records');
    assert(recXYZ!.contactCount === 3, `XYZ Ltd contactCount = 3 (Got: ${recXYZ?.contactCount})`);
    assert(recXYZ!.representativeContacts.length === 3, `XYZ Ltd representativeContacts has 3 entries (Got: ${recXYZ?.representativeContacts.length})`);

    // Check expandable contacts via getCompanyContactsList
    const xyzContacts = getCompanyContactsList(recXYZ!.normalizedName, batch4Id);
    assert(xyzContacts.length === 3, `getCompanyContactsList returns 3 contacts for XYZ Ltd (Got: ${xyzContacts.length})`);
    assert(xyzContacts.every((c) => c.email.includes('@xyz.com')), 'All contacts have xyz.com email');

    // -------------------------------------------------------------------
    // TEST 8: Zero State
    // No contacts -> Duplicate Companies = 0 and empty detail list
    // -------------------------------------------------------------------
    console.log('\n--- TEST 8: Zero state ---');
    db.insert(batches).values({
      id: batchZeroId,
      filename: 'Batch_Zero.xlsx',
      uploadDate: now,
      totalRecords: 0,
      validRecords: 0,
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    }).run();

    const statsZero = getProcessingPipelineStats(batchZeroId);
    assert(statsZero.companiesFound === 0, `Companies Found = 0 (Got: ${statsZero.companiesFound})`);
    assert(statsZero.duplicateCompanies === 0, `Duplicate Companies = 0 (Got: ${statsZero.duplicateCompanies})`);

    const detailZero = getDuplicateCompaniesList({ batchId: batchZeroId });
    assert(detailZero.total === 0, `Detail total = 0 (Got: ${detailZero.total})`);
    assert(detailZero.records.length === 0, `Detail records length = 0 (Got: ${detailZero.records.length})`);

    console.log('\n======================================================================');
    console.log('✔ ALL 8 DUPLICATE COMPANIES TEST SCENARIOS PASSED PERFECTLY!');
    console.log('======================================================================');
  } finally {
    // Cleanup fixtures
    db.delete(batches).where(sql`id LIKE 'batch_test_dup_%'`).run();
  }
}

runDuplicateCompaniesTestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
