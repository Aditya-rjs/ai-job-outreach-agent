import { deleteBatch } from '../../src/lib/pipeline/batch-manager';
import { initializeDatabase } from '../../src/db/migrate';

async function run() {
  const batchId = process.argv[2];
  if (!batchId) {
    console.error(JSON.stringify({ error: 'Missing batchId argument' }));
    process.exit(1);
  }

  initializeDatabase();
  const result = deleteBatch(batchId);
  console.log('DELETE_RESULT:' + JSON.stringify(result));
}

run().catch((err) => {
  console.error('DELETE_ERROR:' + (err?.message || err));
  process.exit(1);
});
