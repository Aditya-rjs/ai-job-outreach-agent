import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { contacts } from './contacts';

export const outreachQueue = sqliteTable(
  'outreach_queue',
  {
    id: text('id').primaryKey(),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    priority: integer('priority').default(0).notNull(),
    scheduledFor: text('scheduled_for'),
    status: text('status', {
      enum: ['pending', 'processing', 'completed', 'failed', 'cancelled', 'uncertain', 'blocked'],
    })
      .default('pending')
      .notNull(),
    attempts: integer('attempts').default(0).notNull(),
    leaseExpiresAt: text('lease_expires_at'),
    workerId: text('worker_id'),
    lastAttemptAt: text('last_attempt_at'),
    nextRetryAt: text('next_retry_at'),
    errorMessage: text('error_message'),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_queue_status').on(table.status),
    index('idx_queue_priority').on(table.priority),
    index('idx_queue_contact_id').on(table.contactId),
    index('idx_queue_scheduled_for').on(table.scheduledFor),
  ]
);
