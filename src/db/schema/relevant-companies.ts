import { sqliteTable, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const relevantCompanies = sqliteTable(
  'relevant_companies',
  {
    id: text('id').primaryKey(),
    canonicalName: text('canonical_name').notNull(),
    normalizedCanonicalName: text('normalized_canonical_name').notNull().unique(),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_relcomp_norm').on(table.normalizedCanonicalName),
  ]
);

export const relevantCompanyAliases = sqliteTable(
  'relevant_company_aliases',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => relevantCompanies.id, { onDelete: 'cascade' }),
    aliasName: text('alias_name').notNull(),
    normalizedAliasName: text('normalized_alias_name').notNull().unique(),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_relcomp_aliases_norm').on(table.normalizedAliasName),
    index('idx_relcomp_aliases_comp_id').on(table.companyId),
  ]
);
