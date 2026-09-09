/**
 * Standalone Seed & Backfill Tool for Persistent Relevant Company Knowledge Base
 *
 * Scans existing authoritative relevant companies from contacts and company_classifications,
 * computes deterministic normalized keys, reports collisions, and safely seeds the KB.
 *
 * SAFETY INVARIANTS:
 * - Makes ZERO AI calls.
 * - Defaults to --dry-run (0 database writes).
 * - Only modifies database when --apply is explicitly passed.
 * - Completely idempotent (rerunning produces 0 duplicates and does not overwrite).
 * - Never run against production automatically.
 *
 * Usage:
 *   npx tsx scripts/seed-relevant-companies-kb.ts             # Dry-run report (default)
 *   npx tsx scripts/seed-relevant-companies-kb.ts --dry-run   # Explicit dry-run
 *   npx tsx scripts/seed-relevant-companies-kb.ts --apply     # Execute idempotent backfill
 */

import { getDb } from '../src/db';
import { initializeDatabase } from '../src/db/migrate';
import { relevantCompanies, relevantCompanyAliases } from '../src/db/schema';
import { normalizeCompanyName, formatCompanyDisplayName } from '../src/lib/utils/company';
import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';

export interface SeedReport {
  isDryRun: boolean;
  totalRawNamesFound: number;
  uniqueNormalizedCount: number;
  collisionCount: number;
  collisions: Array<{ normalized: string; variants: string[] }>;
  existingInKbCount: number;
  newCompaniesToCreate: number;
  newAliasesToCreate: number;
  insertedCompanies: number;
  insertedAliases: number;
}

export function runSeedRelevantCompanies(options: { apply?: boolean } = {}): SeedReport {
  const isDryRun = !options.apply;
  const db = getDb();

  // Ensure DB schema & tables exist
  initializeDatabase();

  console.log('======================================================================');
  console.log(`[SeedRelevantCompaniesKB] Mode: ${isDryRun ? 'DRY-RUN (No changes)' : 'APPLY (Idempotent seed)'}`);
  console.log('======================================================================');

  // 1. Fetch authoritative relevant companies from contacts
  const contactsRows = db.all<{ rawName: string }>(sql`
    SELECT DISTINCT TRIM(company_name) as rawName
    FROM contacts
    WHERE is_relevant = 1
      AND company_name IS NOT NULL
      AND TRIM(company_name) != ''
      AND batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
  `);

  // 2. Fetch authoritative relevant companies from company_classifications
  const ccRows = db.all<{ rawName: string }>(sql`
    SELECT company_name as rawName
    FROM company_classifications
    WHERE classification_result = 'RELEVANT'
      AND is_relevant = 1
      AND company_name IS NOT NULL
      AND TRIM(company_name) != ''
  `);

  // Deduplicate raw names
  const rawNamesSet = new Set<string>();
  for (const r of contactsRows) {
    if (r.rawName) rawNamesSet.add(r.rawName.trim());
  }
  for (const r of ccRows) {
    if (r.rawName) rawNamesSet.add(r.rawName.trim());
  }

  const rawNamesList = Array.from(rawNamesSet);
  console.log(`[Seed] Found ${rawNamesList.length} distinct raw company names from existing authoritative data.`);

  // 3. Group by normalizeCompanyName()
  const groups = new Map<string, Set<string>>(); // normalized -> Set of raw variants
  for (const raw of rawNamesList) {
    const norm = normalizeCompanyName(raw);
    if (!norm) continue;
    if (!groups.has(norm)) {
      groups.set(norm, new Set());
    }
    groups.get(norm)!.add(raw);
  }

  const collisions: Array<{ normalized: string; variants: string[] }> = [];
  for (const [norm, variants] of groups.entries()) {
    if (variants.size > 1) {
      collisions.push({
        normalized: norm,
        variants: Array.from(variants),
      });
    }
  }

  console.log(`[Seed] Grouped into ${groups.size} unique normalized company keys.`);
  console.log(`[Seed] Identified ${collisions.length} normalized collisions (variants mapping to same normalized key).`);

  // 4. Check existing KB state
  const existingCompanies = db.all<{ id: string; normalized: string }>(sql`
    SELECT id, normalized_canonical_name as normalized
    FROM relevant_companies
  `);
  const existingNormalizedSet = new Set(existingCompanies.map((c) => c.normalized));

  const existingAliases = db.all<{ normalized: string }>(sql`
    SELECT normalized_alias_name as normalized
    FROM relevant_company_aliases
  `);
  const existingAliasSet = new Set(existingAliases.map((a) => a.normalized));

  let newCompaniesToCreate = 0;
  let newAliasesToCreate = 0;

  for (const [norm, variants] of groups.entries()) {
    if (!existingNormalizedSet.has(norm)) {
      newCompaniesToCreate++;
    }
    for (const v of variants) {
      const vNorm = normalizeCompanyName(v);
      if (!existingAliasSet.has(vNorm)) {
        newAliasesToCreate++;
      }
    }
  }

  console.log('----------------------------------------------------------------------');
  console.log(`[Seed Summary] Existing canonical companies in KB: ${existingNormalizedSet.size}`);
  console.log(`[Seed Summary] Existing aliases in KB: ${existingAliasSet.size}`);
  console.log(`[Seed Summary] New canonical companies to create: ${newCompaniesToCreate}`);
  console.log(`[Seed Summary] New aliases to create: ${newAliasesToCreate}`);
  console.log('----------------------------------------------------------------------');

  let insertedCompanies = 0;
  let insertedAliases = 0;

  if (isDryRun) {
    console.log('[Seed] Dry-run completed. Zero writes made, zero AI calls made.');
  } else {
    // APPLY: Execute atomic, idempotent inserts
    const nowIso = new Date().toISOString();

    db.transaction((tx) => {
      for (const [norm, variants] of groups.entries()) {
        const variantsList = Array.from(variants);

        // Pick the best canonical name: cleanest/shortest display name
        const sorted = [...variantsList].sort((a, b) => a.length - b.length);
        const canonicalName = formatCompanyDisplayName(sorted[0]);

        // Insert into relevant_companies (INSERT OR IGNORE preserves existing)
        const companyId = `relcomp_${ulid()}`;
        const resComp = tx.run(sql`
          INSERT OR IGNORE INTO relevant_companies (
            id, canonical_name, normalized_canonical_name, created_at, updated_at
          ) VALUES (
            ${companyId}, ${canonicalName}, ${norm}, ${nowIso}, ${nowIso}
          )
        `);
        if (resComp.changes > 0) {
          insertedCompanies++;
        }

        // Fetch actual company ID (in case already existed)
        const actualComp = tx.get<{ id: string }>(sql`
          SELECT id FROM relevant_companies WHERE normalized_canonical_name = ${norm} LIMIT 1
        `);
        const actualId = actualComp ? actualComp.id : companyId;

        // Insert each variant as an alias (INSERT OR IGNORE ensures idempotency)
        for (const v of variantsList) {
          const vNorm = normalizeCompanyName(v);
          const aliasId = `alias_${ulid()}`;
          const resAlias = tx.run(sql`
            INSERT OR IGNORE INTO relevant_company_aliases (
              id, company_id, alias_name, normalized_alias_name, created_at
            ) VALUES (
              ${aliasId}, ${actualId}, ${formatCompanyDisplayName(v)}, ${vNorm}, ${nowIso}
            )
          `);
          if (resAlias.changes > 0) {
            insertedAliases++;
          }
        }
      }
    });

    console.log(`[Seed] Apply completed successfully! Inserted ${insertedCompanies} companies and ${insertedAliases} aliases.`);
  }

  return {
    isDryRun,
    totalRawNamesFound: rawNamesList.length,
    uniqueNormalizedCount: groups.size,
    collisionCount: collisions.length,
    collisions,
    existingInKbCount: existingNormalizedSet.size,
    newCompaniesToCreate,
    newAliasesToCreate,
    insertedCompanies,
    insertedAliases,
  };
}

// Direct execution from CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const report = runSeedRelevantCompanies({ apply });

  if (report.collisionCount > 0) {
    console.log('\nSample of detected collisions (multi-variant names sharing normalized key):');
    for (const c of report.collisions.slice(0, 10)) {
      console.log(`  - '${c.normalized}' <- [${c.variants.map((v) => `'${v}'`).join(', ')}]`);
    }
  }

  console.log('\nDone.');
}
