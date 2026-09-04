import { acquireNextEligibleJob } from '../../src/lib/scheduler/queue-manager';
import { initializeDatabase } from '../../src/db/migrate';

initializeDatabase();
const job = acquireNextEligibleJob('test_worker');
console.log('WORKER_JOB:' + JSON.stringify(job));
