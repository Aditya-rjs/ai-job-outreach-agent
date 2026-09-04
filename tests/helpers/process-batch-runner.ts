import fs from 'fs';
import { processBatchFile } from '../../src/lib/pipeline/batch-processor';
import { initializeDatabase } from '../../src/db/migrate';

async function run() {
  const filePath = process.argv[2];
  const filename = process.argv[3] || filePath;
  if (!filePath) {
    console.error(JSON.stringify({ error: 'Missing filePath argument' }));
    process.exit(1);
  }

  initializeDatabase();
  const fileBuffer = fs.readFileSync(filePath);
  const result = await processBatchFile(fileBuffer, filename);
  console.log('BATCH_RESULT:' + JSON.stringify(result));
}

run().catch((err) => {
  console.error('BATCH_ERROR:' + (err?.message || err));
  process.exit(1);
});
