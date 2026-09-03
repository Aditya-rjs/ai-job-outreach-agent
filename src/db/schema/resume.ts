import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const resume = sqliteTable('resume', {
  id: text('id').primaryKey().default('current'),
  filename: text('filename').notNull(),
  filePath: text('file_path').notNull(),
  mimeType: text('mime_type').notNull(),
  parsedText: text('parsed_text'),
  parsedData: text('parsed_data'),  // JSON string of structured resume profile
  version: text('version'),          // Version identifier / timestamp of the resume
  uploadedAt: text('uploaded_at').notNull().$defaultFn(() => new Date().toISOString()),
});
