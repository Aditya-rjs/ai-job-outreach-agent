import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const candidateProfile = sqliteTable('candidate_profile', {
  id: text('id').primaryKey().default('singleton'),
  fullName: text('full_name').notNull().default(''),
  email: text('email').notNull().default(''),
  phone: text('phone').notNull().default(''),
  degree: text('degree').notNull().default(''),
  fieldOfStudy: text('field_of_study').notNull().default(''),
  institution: text('institution').notNull().default(''),
  graduationYear: text('graduation_year').notNull().default(''),
  linkedin: text('linkedin').notNull().default(''),
  github: text('github').notNull().default(''),
  portfolio: text('portfolio').notNull().default(''),
  education: text('education').notNull().default('[]'),
  experience: text('experience').notNull().default('[]'),
  projects: text('projects').notNull().default('[]'),
  skills: text('skills').notNull().default('{"languages":[],"frameworks":[],"databases":[],"cloudDevOps":[],"tools":[],"other":[]}'),
  achievements: text('achievements').notNull().default('[]'),
  version: text('version').notNull().default('1'),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});
