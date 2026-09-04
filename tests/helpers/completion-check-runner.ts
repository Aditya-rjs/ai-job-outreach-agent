import { checkBatchCompletions } from '../../src/lib/scheduler/queue-manager';
import { initializeDatabase } from '../../src/db/migrate';

async function run() {
  initializeDatabase();
  const res = checkBatchCompletions();
  console.log('COMPLETION_RESULT:' + JSON.stringify(res));
}

run().catch((err) => {
  console.error('COMPLETION_ERROR:' + (err?.message || err));
  process.exit(1);
});
