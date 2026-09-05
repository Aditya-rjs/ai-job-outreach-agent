import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const companyClassifications = sqliteTable('company_classifications', {
  normalizedName: text('normalized_name').primaryKey(),
  companyName: text('company_name').notNull(),
  isRelevant: integer('is_relevant', { mode: 'boolean' }), // null for PENDING or NEEDS_REVIEW
  confidence: real('confidence'),
  reason: text('reason').notNull(),
  classificationSource: text('classification_source').default('gemini').notNull(),
  geminiModel: text('gemini_model').default('gemini-3.8-flash').notNull(),
  classificationResult: text('classification_result').default('PENDING').notNull(), // 'RELEVANT' | 'IRRELEVANT' | 'NEEDS_REVIEW' | 'PENDING' | 'FAILED'
  retryCount: integer('retry_count').default(0).notNull(),
  lastErrorCategory: text('last_error_category'),
  nextRetryAt: text('next_retry_at'),
  claimToken: text('claim_token'),
  leaseExpiresAt: text('lease_expires_at'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

