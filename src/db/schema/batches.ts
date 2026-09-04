import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const batches = sqliteTable('batches', {
  id: text('id').primaryKey(),
  filename: text('filename').notNull(),
  filePath: text('file_path'),
  uploadDate: text('upload_date').notNull(),
  totalRecords: integer('total_records').default(0).notNull(),
  validRecords: integer('valid_records').default(0).notNull(),
  relevantCompanies: integer('relevant_companies').default(0).notNull(),
  irrelevantCompanies: integer('irrelevant_companies').default(0).notNull(),
  duplicateContacts: integer('duplicate_contacts').default(0).notNull(),
  invalidEmails: integer('invalid_emails').default(0).notNull(),
  emailsSent: integer('emails_sent').default(0).notNull(),
  emailsSimulated: integer('emails_simulated').default(0).notNull(),
  emailsFailed: integer('emails_failed').default(0).notNull(),
  emailsPending: integer('emails_pending').default(0).notNull(),
  status: text('status', { enum: ['processing', 'queued', 'sending', 'paused', 'completed', 'failed', 'cancelled', 'deleted'] }).default('processing').notNull(),
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});
