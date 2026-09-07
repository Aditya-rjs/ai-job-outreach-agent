import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const aiProviderState = sqliteTable('ai_provider_state', {
  id: text('id').primaryKey().default('singleton'),
  activeProvider: text('active_provider', { enum: ['gemini', 'openrouter', 'waiting'] })
    .default('gemini')
    .notNull(),
  geminiCooldownUntil: text('gemini_cooldown_until'),
  geminiLastError: text('gemini_last_error'),
  openrouterCooldownUntil: text('openrouter_cooldown_until'),
  openrouterLastError: text('openrouter_last_error'),
  totalDispatches: integer('total_dispatches').default(0).notNull(),
  geminiSuccesses: integer('gemini_successes').default(0).notNull(),
  geminiFailures: integer('gemini_failures').default(0).notNull(),
  gemini429Count: integer('gemini_429_count').default(0).notNull(),
  openrouterDispatches: integer('openrouter_dispatches').default(0).notNull(),
  openrouterSuccesses: integer('openrouter_successes').default(0).notNull(),
  openrouterFailures: integer('openrouter_failures').default(0).notNull(),
  fallbackCount: integer('fallback_count').default(0).notNull(),
  lastFallbackAt: text('last_fallback_at'),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});
