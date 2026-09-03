import { getDb } from '@/db';
import { schedulerState } from '@/db/schema';
import { sql } from 'drizzle-orm';

const LEASE_DURATION_MS = 90 * 1000; // 90 seconds lease duration

export interface WorkerLeaseResult {
  acquired: boolean;
  workerId: string;
  lockedUntil?: string;
  reason?: string;
}

/**
 * Attempts to acquire or renew a global worker lock in the scheduler_state table.
 * Returns true if this worker has acquired or successfully renewed the lease.
 */
export function acquireWorkerLease(workerId: string): WorkerLeaseResult {
  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const lockedUntil = new Date(now.getTime() + LEASE_DURATION_MS).toISOString();

  // Atomic update: only succeeds if no worker holds the lease, the current lease is expired, or this worker already owns it
  const updateResult = db.run(sql`
    UPDATE scheduler_state
    SET
      worker_id = ${workerId},
      locked_until = ${lockedUntil},
      last_heartbeat_at = ${nowIso}
    WHERE id = 'singleton'
      AND (
        worker_id IS NULL
        OR worker_id = ${workerId}
        OR locked_until IS NULL
        OR locked_until < ${nowIso}
      )
  `);

  if (updateResult.changes > 0) {
    return {
      acquired: true,
      workerId,
      lockedUntil,
    };
  }

  // Find who holds the lease
  const current = db
    .select({
      workerId: schedulerState.workerId,
      lockedUntil: schedulerState.lockedUntil,
    })
    .from(schedulerState)
    .where(sql`id = 'singleton'`)
    .get();

  return {
    acquired: false,
    workerId,
    reason: `Lease currently held by worker "${current?.workerId}" until ${current?.lockedUntil}`,
  };
}

/**
 * Renews an existing lease held by this worker.
 */
export function renewWorkerLease(workerId: string): boolean {
  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const lockedUntil = new Date(now.getTime() + LEASE_DURATION_MS).toISOString();

  const updateResult = db.run(sql`
    UPDATE scheduler_state
    SET
      locked_until = ${lockedUntil},
      last_heartbeat_at = ${nowIso}
    WHERE id = 'singleton'
      AND worker_id = ${workerId}
  `);

  return updateResult.changes > 0;
}

/**
 * Safely releases the worker lease upon graceful shutdown.
 */
export function releaseWorkerLease(workerId: string): void {
  const db = getDb();
  db.run(sql`
    UPDATE scheduler_state
    SET
      worker_id = NULL,
      locked_until = NULL,
      last_heartbeat_at = ${new Date().toISOString()}
    WHERE id = 'singleton'
      AND worker_id = ${workerId}
  `);
}

/**
 * Checks whether the worker lease is currently held by any active (non-expired) worker.
 */
export function isLeaseActive(): { isActive: boolean; workerId: string | null; lockedUntil: string | null } {
  const db = getDb();
  const current = db
    .select({
      workerId: schedulerState.workerId,
      lockedUntil: schedulerState.lockedUntil,
    })
    .from(schedulerState)
    .where(sql`id = 'singleton'`)
    .get();

  if (!current || !current.workerId || !current.lockedUntil) {
    return { isActive: false, workerId: null, lockedUntil: null };
  }

  const isExpired = new Date(current.lockedUntil).getTime() <= Date.now();
  return {
    isActive: !isExpired,
    workerId: isExpired ? null : current.workerId,
    lockedUntil: current.lockedUntil,
  };
}
