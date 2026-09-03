import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { contacts } from './contacts';
import { batches } from './batches';

export const globalEmailHistory = sqliteTable('global_email_history', {
  email: text('email').primaryKey(),  // Normalized lowercase trimmed email
  firstContactId: text('first_contact_id').references(() => contacts.id),
  firstBatchId: text('first_batch_id').references(() => batches.id),
  firstSeenAt: text('first_seen_at').notNull().$defaultFn(() => new Date().toISOString()),
  sentAt: text('sent_at'),  // NULL until successfully sent
  status: text('status', { enum: ['discovered', 'queued', 'sending', 'sent', 'failed'] }).default('discovered').notNull(),
});
