import { getDb } from '@/db';
import { relevantCompanies, relevantCompanyAliases } from '@/db/schema';
import { normalizeCompanyName, formatCompanyDisplayName } from '@/lib/utils/company';
import { sql, inArray, eq } from 'drizzle-orm';
import { ulid } from 'ulid';

export interface RelevantCompanyMatch {
  companyId: string;
  canonicalName: string;
  matchedAs: 'canonical' | 'alias';
}

export interface PersistenceResult {
  companyId: string;
  canonicalName: string;
  isNewCompany: boolean;
  aliasAdded: boolean;
}

/**
 * Searches the Relevant Company Knowledge Base for a single company name.
 * Checks BOTH relevant_companies (normalized canonical name) and
 * relevant_company_aliases (normalized alias name).
 *
 * Returns the match details if FOUND, or null if NOT FOUND.
 * Makes ZERO AI calls.
 */
export function searchCompanyDatabase(
  rawName: string | null | undefined,
  db = getDb()
): RelevantCompanyMatch | null {
  if (!rawName) return null;
  const norm = normalizeCompanyName(rawName);
  if (!norm) return null;

  try {
    // Single fast indexed query checking canonical and alias tables
    const row = db.get<{
      companyId: string;
      canonicalName: string;
      matchedAs: string;
    }>(sql`
      SELECT id as companyId, canonical_name as canonicalName, 'canonical' as matchedAs
      FROM relevant_companies
      WHERE normalized_canonical_name = ${norm}
      UNION ALL
      SELECT a.company_id as companyId, c.canonical_name as canonicalName, 'alias' as matchedAs
      FROM relevant_company_aliases a
      JOIN relevant_companies c ON a.company_id = c.id
      WHERE a.normalized_alias_name = ${norm}
      LIMIT 1
    `);

    if (row) {
      console.log(`[RelevantCompanyKB] KB Hit (${row.matchedAs}): '${rawName}' -> '${row.canonicalName}' (ID: ${row.companyId})`);
      return {
        companyId: row.companyId,
        canonicalName: row.canonicalName,
        matchedAs: row.matchedAs as 'canonical' | 'alias',
      };
    }

    return null;
  } catch (err) {
    console.warn('[RelevantCompanyKB] Error querying knowledge base:', err);
    return null;
  }
}

/**
 * Searches the Relevant Company Knowledge Base in chunks for a list of company names.
 * Returns a Map keyed by normalized company name.
 * Makes ZERO AI calls.
 */
export function searchCompanyDatabaseBatch(
  rawNames: string[],
  db = getDb()
): Map<string, RelevantCompanyMatch> {
  const resultMap = new Map<string, RelevantCompanyMatch>();
  if (!rawNames || rawNames.length === 0) return resultMap;

  const normToOriginal = new Map<string, string>();
  for (const name of rawNames) {
    if (!name) continue;
    const norm = normalizeCompanyName(name);
    if (norm && !normToOriginal.has(norm)) {
      normToOriginal.set(norm, name);
    }
  }

  const normalizedKeys = Array.from(normToOriginal.keys());
  if (normalizedKeys.length === 0) return resultMap;

  const CHUNK_SIZE = 200;
  for (let i = 0; i < normalizedKeys.length; i += CHUNK_SIZE) {
    const chunk = normalizedKeys.slice(i, i + CHUNK_SIZE);

    try {
      // 1. Check canonical names
      const canonicalRows = db
        .select({
          id: relevantCompanies.id,
          canonicalName: relevantCompanies.canonicalName,
          normalizedCanonicalName: relevantCompanies.normalizedCanonicalName,
        })
        .from(relevantCompanies)
        .where(inArray(relevantCompanies.normalizedCanonicalName, chunk))
        .all();

      for (const r of canonicalRows) {
        resultMap.set(r.normalizedCanonicalName, {
          companyId: r.id,
          canonicalName: r.canonicalName,
          matchedAs: 'canonical',
        });
      }

      // 2. Check aliases for any keys not matched yet
      const remainingKeys = chunk.filter((k) => !resultMap.has(k));
      if (remainingKeys.length > 0) {
        const aliasRows = db
          .select({
            companyId: relevantCompanyAliases.companyId,
            aliasName: relevantCompanyAliases.aliasName,
            normalizedAliasName: relevantCompanyAliases.normalizedAliasName,
            canonicalName: relevantCompanies.canonicalName,
          })
          .from(relevantCompanyAliases)
          .innerJoin(relevantCompanies, eq(relevantCompanyAliases.companyId, relevantCompanies.id))
          .where(inArray(relevantCompanyAliases.normalizedAliasName, remainingKeys))
          .all();

        for (const r of aliasRows) {
          resultMap.set(r.normalizedAliasName, {
            companyId: r.companyId,
            canonicalName: r.canonicalName,
            matchedAs: 'alias',
          });
        }
      }
    } catch (err) {
      console.warn('[RelevantCompanyKB] Error in batch KB lookup chunk:', err);
    }
  }

  if (resultMap.size > 0) {
    console.log(`[RelevantCompanyKB] Batch lookup: ${resultMap.size} of ${normalizedKeys.length} distinct companies FOUND in KB.`);
  }

  return resultMap;
}

/**
 * Persists an AI-determined canonical company name and its observed variant into the KB.
 *
 * Local DB Lookup flow:
 * 1. Normalize AI canonical name using normalizeCompanyName().
 * 2. Search local DB (relevant_companies.normalized_canonical_name).
 * 3. FOUND:
 *    - Use existing company ID.
 *    - Add observed name as alias under existing company ID.
 * 4. NOT FOUND:
 *    - Create new company identity in relevant_companies.
 *    - Add observed name as alias in relevant_company_aliases.
 *
 * Safe under concurrent execution (atomic transaction with INSERT OR IGNORE and collision handling).
 */
export function resolveCanonicalAndPersist(
  aiCanonicalName: string,
  observedName: string,
  db = getDb()
): PersistenceResult {
  const cleanCanonical = formatCompanyDisplayName(aiCanonicalName);
  const cleanObserved = formatCompanyDisplayName(observedName);

  const normCanonical = normalizeCompanyName(cleanCanonical);
  const normObserved = normalizeCompanyName(cleanObserved);

  if (!normCanonical) {
    throw new Error(`Cannot persist empty canonical company name: '${aiCanonicalName}'`);
  }
  if (!normObserved) {
    throw new Error(`Cannot persist empty observed company name: '${observedName}'`);
  }

  const nowIso = new Date().toISOString();

  // Execute inside an atomic SQLite transaction
  return db.transaction((tx) => {
    // 1. Search local DB: does normalized_canonical_name already exist?
    const existing = tx.get<{
      id: string;
      canonical_name: string;
    }>(sql`
      SELECT id, canonical_name
      FROM relevant_companies
      WHERE normalized_canonical_name = ${normCanonical}
      LIMIT 1
    `);

    if (existing) {
      // FOUND: Existing company identity matches this canonical name!
      const companyId = existing.id;
      const canonicalName = existing.canonical_name;

      // Add newly observed name as an alias under existing company
      let aliasAdded = false;
      const aliasId = `alias_${ulid()}`;
      const insertRes = tx.run(sql`
        INSERT OR IGNORE INTO relevant_company_aliases (
          id, company_id, alias_name, normalized_alias_name, created_at
        ) VALUES (
          ${aliasId}, ${companyId}, ${cleanObserved}, ${normObserved}, ${nowIso}
        )
      `);

      if (insertRes.changes > 0) {
        aliasAdded = true;
        console.log(`[RelevantCompanyKB] Canonical Match: Observed '${cleanObserved}' added as alias of existing '${canonicalName}' (ID: ${companyId})`);
      } else {
        console.log(`[RelevantCompanyKB] Canonical Match: Alias '${cleanObserved}' already exists for '${canonicalName}' (ID: ${companyId})`);
      }

      return {
        companyId,
        canonicalName,
        isNewCompany: false,
        aliasAdded,
      };
    }

    // NOT FOUND: Create new company identity!
    const newCompanyId = `relcomp_${ulid()}`;

    // INSERT OR IGNORE handles any simultaneous race condition
    tx.run(sql`
      INSERT OR IGNORE INTO relevant_companies (
        id, canonical_name, normalized_canonical_name, created_at, updated_at
      ) VALUES (
        ${newCompanyId}, ${cleanCanonical}, ${normCanonical}, ${nowIso}, ${nowIso}
      )
    `);

    // Fetch the actual record to resolve any concurrent race condition cleanly
    const resolvedComp = tx.get<{
      id: string;
      canonical_name: string;
    }>(sql`
      SELECT id, canonical_name
      FROM relevant_companies
      WHERE normalized_canonical_name = ${normCanonical}
      LIMIT 1
    `);

    const finalCompanyId = resolvedComp ? resolvedComp.id : newCompanyId;
    const finalCanonicalName = resolvedComp ? resolvedComp.canonical_name : cleanCanonical;
    const isNew = finalCompanyId === newCompanyId;

    // Add observed name as alias
    const aliasId = `alias_${ulid()}`;
    tx.run(sql`
      INSERT OR IGNORE INTO relevant_company_aliases (
        id, company_id, alias_name, normalized_alias_name, created_at
      ) VALUES (
        ${aliasId}, ${finalCompanyId}, ${cleanObserved}, ${normObserved}, ${nowIso}
      )
    `);

    if (isNew) {
      console.log(`[RelevantCompanyKB] New Company Created: Canonical '${finalCanonicalName}' (ID: ${finalCompanyId}) with alias '${cleanObserved}'`);
    } else {
      console.log(`[RelevantCompanyKB] Race Resolved: Joined existing '${finalCanonicalName}' (ID: ${finalCompanyId}) with alias '${cleanObserved}'`);
    }

    return {
      companyId: finalCompanyId,
      canonicalName: finalCanonicalName,
      isNewCompany: isNew,
      aliasAdded: true,
    };
  });
}

/**
 * Directly records an alias for an existing company ID.
 * Uses INSERT OR IGNORE for idempotency.
 */
export function recordCompanyAlias(
  companyId: string,
  aliasName: string,
  db = getDb()
): boolean {
  if (!companyId || !aliasName) return false;
  const cleanAlias = formatCompanyDisplayName(aliasName);
  const normAlias = normalizeCompanyName(aliasName);
  if (!normAlias) return false;

  const aliasId = `alias_${ulid()}`;
  const nowIso = new Date().toISOString();

  const res = db.run(sql`
    INSERT OR IGNORE INTO relevant_company_aliases (
      id, company_id, alias_name, normalized_alias_name, created_at
    ) VALUES (
      ${aliasId}, ${companyId}, ${cleanAlias}, ${normAlias}, ${nowIso}
    )
  `);

  return res.changes > 0;
}
