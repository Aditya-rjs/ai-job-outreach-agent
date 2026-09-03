import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const companyClassifications = sqliteTable('company_classifications', {
  normalizedName: text('normalized_name').primaryKey(),
  companyName: text('company_name').notNull(),
  isRelevant: integer('is_relevant', { mode: 'boolean' }).notNull(),
  confidence: real('confidence').notNull(),
  reason: text('reason').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});
