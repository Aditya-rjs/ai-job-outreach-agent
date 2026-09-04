import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { batches } from './batches';

export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  batchId: text('batch_id').notNull().references(() => batches.id, { onDelete: 'cascade' }),
  companyName: text('company_name'),
  contactName: text('contact_name'),
  email: text('email').notNull(),
  designation: text('designation'),
  companyWebsite: text('company_website'),
  companyLocation: text('company_location'),
  isRelevant: integer('is_relevant', { mode: 'boolean' }),
  relevanceConfidence: real('relevance_confidence'),
  relevanceReason: text('relevance_reason'),
  isDuplicate: integer('is_duplicate', { mode: 'boolean' }).default(false).notNull(),
  emailValid: integer('email_valid', { mode: 'boolean' }).default(true).notNull(),
  status: text('status', { enum: ['discovered', 'queued', 'generating', 'generated', 'processing', 'sending', 'sent', 'simulated', 'failed', 'skipped', 'uncertain'] }).default('discovered').notNull(),
  emailSubject: text('email_subject'),
  emailBody: text('email_body'),
  emailStrategy: text('email_strategy'),
  personalizationPoints: text('personalization_points'), // JSON array of points
  resumeVersion: text('resume_version'),                 // Version/timestamp of resume used
  generatedAt: text('generated_at'),
  gmailMessageId: text('gmail_message_id'),
  sentAt: text('sent_at'),
  errorMessage: text('error_message'),
  sendAttemptCount: integer('send_attempt_count').default(0).notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ([
  index('idx_contacts_batch_id').on(table.batchId),
  index('idx_contacts_email').on(table.email),
  index('idx_contacts_status').on(table.status),
]));
