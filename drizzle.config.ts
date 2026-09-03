import { defineConfig } from 'drizzle-kit';
import path from 'path';

const dataDir = process.env.DATA_DIR?.trim()
  ? (path.isAbsolute(process.env.DATA_DIR.trim())
      ? process.env.DATA_DIR.trim()
      : path.resolve(process.cwd(), process.env.DATA_DIR.trim()))
  : path.resolve(process.cwd(), 'data');

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: path.join(dataDir, 'outreach.db'),
  },
});
