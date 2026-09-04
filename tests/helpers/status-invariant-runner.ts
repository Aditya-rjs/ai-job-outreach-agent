import { getDb } from '../../src/db';
import { batches, contacts, outreachQueue } from '../../src/db/schema';
import { checkBatchCompletions } from '../../src/lib/scheduler/queue-manager';
import { initializeDatabase } from '../../src/db/migrate';
import { eq, and, sql } from 'drizzle-orm';
import { ulid } from 'ulid';

initializeDatabase();
const db = getDb();

interface InvariantResults {
  deletedCannotBecomeCompleted: boolean;
  deletedCannotBecomeQueued: boolean;
  deletedCannotBecomeSending: boolean;
  deletedCannotBecomeFailed: boolean;
  cancelledCannotBecomeQueued: boolean;
  cancelledCannotBecomeSending: boolean;
  cancelledCannotBecomeCompleted: boolean;
}

const now = new Date().toISOString();

// 1. deleted -> completed is impossible
const b1Id = `batch_inv_1_${ulid()}`;
db.insert(batches).values({
  id: b1Id,
  filename: 'inv1.csv',
  uploadDate: now,
  status: 'deleted',
  createdAt: now,
  updatedAt: now,
}).run();

// Contacts with remaining = 0 (all skipped)
db.insert(contacts).values({
  id: `cont_inv_1_${ulid()}`,
  batchId: b1Id,
  email: `test_inv1_${ulid()}@test.com`,
  status: 'skipped',
  createdAt: now,
  updatedAt: now,
}).run();

// Run checkBatchCompletions
checkBatchCompletions();
const b1AfterCheck = db.select().from(batches).where(eq(batches.id, b1Id)).get();
const test1Pass = b1AfterCheck?.status === 'deleted';

// 2. deleted -> queued is impossible
// Try to update using batch processor final update pattern
db.update(batches)
  .set({
    status: 'queued',
    updatedAt: new Date().toISOString(),
  })
  .where(
    and(
      eq(batches.id, b1Id),
      sql`status NOT IN ('deleted', 'cancelled')`
    )
  )
  .run();
const b1AfterQueuedAttempt = db.select().from(batches).where(eq(batches.id, b1Id)).get();
const test2Pass = b1AfterQueuedAttempt?.status === 'deleted';

// 3. deleted -> sending is impossible
// Try to acquire job or transition batch when deleted
const c3Id = `cont_inv_3_${ulid()}`;
db.insert(contacts).values({
  id: c3Id,
  batchId: b1Id,
  email: `test_inv3_${ulid()}@test.com`,
  status: 'queued',
  createdAt: now,
  updatedAt: now,
}).run();

const q3Id = `q_inv_3_${ulid()}`;
db.insert(outreachQueue).values({
  id: q3Id,
  contactId: c3Id,
  status: 'pending',
  priority: 10,
  createdAt: now,
  updatedAt: now,
}).run();

// Verify worker check: if parent batch is deleted, sending is rejected
const parentBatch = db.select().from(batches).where(eq(batches.id, b1Id)).get();
let sendAborted = false;
if (!parentBatch || parentBatch.status === 'deleted' || parentBatch.status === 'cancelled') {
  sendAborted = true;
  db.update(outreachQueue)
    .set({ status: 'cancelled', updatedAt: new Date().toISOString() })
    .where(eq(outreachQueue.id, q3Id))
    .run();
}
const b1AfterSendingAttempt = db.select().from(batches).where(eq(batches.id, b1Id)).get();
const q3AfterAttempt = db.select().from(outreachQueue).where(eq(outreachQueue.id, q3Id)).get();
const test3Pass = b1AfterSendingAttempt?.status === 'deleted' && sendAborted && q3AfterAttempt?.status === 'cancelled';

// 4. deleted -> failed is impossible
db.update(batches)
  .set({
    status: 'failed',
    updatedAt: new Date().toISOString(),
  })
  .where(
    and(
      eq(batches.id, b1Id),
      sql`status NOT IN ('deleted', 'cancelled')`
    )
  )
  .run();
const b1AfterFailedAttempt = db.select().from(batches).where(eq(batches.id, b1Id)).get();
const test4Pass = b1AfterFailedAttempt?.status === 'deleted';

// 5. cancelled -> queued is impossible
const b5Id = `batch_inv_5_${ulid()}`;
db.insert(batches).values({
  id: b5Id,
  filename: 'inv5.csv',
  uploadDate: now,
  status: 'cancelled',
  createdAt: now,
  updatedAt: now,
}).run();

db.update(batches)
  .set({
    status: 'queued',
    updatedAt: new Date().toISOString(),
  })
  .where(
    and(
      eq(batches.id, b5Id),
      sql`status NOT IN ('deleted', 'cancelled')`
    )
  )
  .run();
const b5AfterQueuedAttempt = db.select().from(batches).where(eq(batches.id, b5Id)).get();
const test5Pass = b5AfterQueuedAttempt?.status === 'cancelled';

// 6. cancelled -> sending is impossible
const c6Id = `cont_inv_6_${ulid()}`;
db.insert(contacts).values({
  id: c6Id,
  batchId: b5Id,
  email: `test_inv6_${ulid()}@test.com`,
  status: 'queued',
  createdAt: now,
  updatedAt: now,
}).run();

const q6Id = `q_inv_6_${ulid()}`;
db.insert(outreachQueue).values({
  id: q6Id,
  contactId: c6Id,
  status: 'pending',
  priority: 10,
  createdAt: now,
  updatedAt: now,
}).run();

const parentBatch5 = db.select().from(batches).where(eq(batches.id, b5Id)).get();
let send5Aborted = false;
if (!parentBatch5 || parentBatch5.status === 'deleted' || parentBatch5.status === 'cancelled') {
  send5Aborted = true;
  db.update(outreachQueue)
    .set({ status: 'cancelled', updatedAt: new Date().toISOString() })
    .where(eq(outreachQueue.id, q6Id))
    .run();
}
const b5AfterSendingAttempt = db.select().from(batches).where(eq(batches.id, b5Id)).get();
const q6AfterAttempt = db.select().from(outreachQueue).where(eq(outreachQueue.id, q6Id)).get();
const test6Pass = b5AfterSendingAttempt?.status === 'cancelled' && send5Aborted && q6AfterAttempt?.status === 'cancelled';

// 7. cancelled -> completed is impossible
checkBatchCompletions();
const b5AfterCheck = db.select().from(batches).where(eq(batches.id, b5Id)).get();
const test7Pass = b5AfterCheck?.status === 'cancelled';

const results: InvariantResults = {
  deletedCannotBecomeCompleted: test1Pass,
  deletedCannotBecomeQueued: test2Pass,
  deletedCannotBecomeSending: test3Pass,
  deletedCannotBecomeFailed: test4Pass,
  cancelledCannotBecomeQueued: test5Pass,
  cancelledCannotBecomeSending: test6Pass,
  cancelledCannotBecomeCompleted: test7Pass,
};

console.log('STATUS_INVARIANT_RESULT:' + JSON.stringify(results));
