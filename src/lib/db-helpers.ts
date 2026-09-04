import { getDb } from '@/db';
import { contacts, outreachQueue, schedulerState, resume, settings } from '@/db/schema';
import { eq, sql, count } from 'drizzle-orm';
import type { DashboardStats, SchedulerConfig, AppSettings } from '@/types';
import { isLeaseActive } from '@/lib/scheduler/worker-lease';
import {
  reconcileDailyQuota,
} from '@/lib/scheduler/queue-manager';
import {
  isWithinDailyWindow,
  getConfiguredTimezone,
} from '@/lib/scheduler/time-utils';

export function getDashboardStats(): DashboardStats {
  const db = getDb();

  // Reconcile quota first
  const quota = reconcileDailyQuota();

  // Aggregate contact metrics
  const contactStats = db
    .select({
      totalContacts: count(),
      emailsSent: sql<number>`SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END)`,
      emailsFailed: sql<number>`SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)`,
      emailsSkipped: sql<number>`SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END)`,
      emailsGenerated: sql<number>`SUM(CASE WHEN status = 'generated' THEN 1 ELSE 0 END)`,
      emailsUncertain: sql<number>`SUM(CASE WHEN status = 'uncertain' THEN 1 ELSE 0 END)`,
      relevantCompanies: sql<number>`SUM(CASE WHEN is_relevant = 1 AND is_duplicate = 0 THEN 1 ELSE 0 END)`,
      totalCompanies: sql<number>`COUNT(DISTINCT CASE WHEN company_name IS NOT NULL AND company_name != '' THEN company_name END)`,
    })
    .from(contacts)
    .where(sql`contacts.batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')`)
    .get() ?? {
    totalContacts: 0,
    emailsSent: 0,
    emailsFailed: 0,
    emailsSkipped: 0,
    emailsGenerated: 0,
    emailsUncertain: 0,
    relevantCompanies: 0,
    totalCompanies: 0,
  };

  // Queue metrics
  const queueStats = db
    .select({
      queueSize: sql<number>`SUM(CASE WHEN outreach_queue.status IN ('pending', 'processing') THEN 1 ELSE 0 END)`,
    })
    .from(outreachQueue)
    .innerJoin(contacts, eq(outreachQueue.contactId, contacts.id))
    .where(sql`contacts.batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')`)
    .get() ?? { queueSize: 0 };

  const queueSize = queueStats.queueSize ?? 0;

  // Scheduler state
  const scheduler = db.select().from(schedulerState).where(eq(schedulerState.id, 'singleton')).get();

  const todaySentCount = quota.todaySentCount;
  const dailyLimit = quota.dailyLimit;
  const isPaused = scheduler?.isPaused ?? false;
  const isStopped = scheduler?.isStopped ?? false;
  const timezone = scheduler?.timezone ?? getConfiguredTimezone();
  const startHour = scheduler?.startHour ?? 10;
  const startMinute = scheduler?.startMinute ?? 0;

  const lease = isLeaseActive();
  const isWithinWindow = isWithinDailyWindow(new Date(), timezone, startHour, startMinute);

  let outreachStatus: DashboardStats['outreachStatus'] = 'idle';
  if (isStopped) {
    outreachStatus = 'stopped';
  } else if (isPaused) {
    outreachStatus = 'paused';
  } else if (todaySentCount >= dailyLimit) {
    outreachStatus = 'quota_reached';
  } else if (queueSize > 0 && !isWithinWindow) {
    outreachStatus = 'waiting';
  } else if (queueSize > 0 && lease.isActive) {
    outreachStatus = 'sending';
  } else if (queueSize > 0) {
    outreachStatus = 'running';
  } else if ((contactStats.emailsSent ?? 0) > 0 && queueSize === 0) {
    outreachStatus = 'completed';
  }

  // Get emails queued count
  const emailsQueued = db
    .select({ count: count() })
    .from(contacts)
    .where(sql`status IN ('queued', 'generating', 'processing')`)
    .get()?.count ?? 0;

  const gmailConnected = db.select().from(settings).where(eq(settings.key, 'gmail_connected')).get();
  const gmailEmail = db.select().from(settings).where(eq(settings.key, 'gmail_email')).get();
  const isDryRun = process.env.OUTREACH_DRY_RUN === 'true';

  return {
    totalCompanies: contactStats.totalCompanies ?? 0,
    relevantCompanies: contactStats.relevantCompanies ?? 0,
    totalContacts: contactStats.totalContacts ?? 0,
    emailsSent: contactStats.emailsSent ?? 0,
    emailsFailed: contactStats.emailsFailed ?? 0,
    emailsQueued,
    emailsGenerated: contactStats.emailsGenerated ?? 0,
    emailsSkipped: contactStats.emailsSkipped ?? 0,
    emailsUncertain: contactStats.emailsUncertain ?? 0,
    todaySentCount,
    dailyLimit,
    remainingToday: Math.max(0, dailyLimit - todaySentCount),
    nextSendAt: scheduler?.nextSendAt ?? null,
    lastSendAt: scheduler?.lastSendAt ?? null,
    queueSize,
    isPaused,
    isStopped,
    isDryRun,
    gmailConnected: gmailConnected?.value === 'true',
    gmailEmail: gmailEmail?.value ?? null,
    outreachStatus,
  };
}

export function getSchedulerConfig(): SchedulerConfig {
  const db = getDb();
  const state = db.select().from(schedulerState).where(eq(schedulerState.id, 'singleton')).get();
  const quota = reconcileDailyQuota();
  const tz = state?.timezone || getConfiguredTimezone();
  const startHour = state?.startHour ?? 10;
  const startMinute = state?.startMinute ?? 0;
  const isWithinWindow = isWithinDailyWindow(new Date(), tz, startHour, startMinute);
  const lease = isLeaseActive();

  let schedulerStatus: SchedulerConfig['schedulerStatus'] = 'waiting';
  if (state?.isStopped) {
    schedulerStatus = 'stopped';
  } else if (state?.isPaused) {
    schedulerStatus = 'paused';
  } else if (quota.todaySentCount >= quota.dailyLimit) {
    schedulerStatus = 'quota_reached';
  } else if (!isWithinWindow) {
    schedulerStatus = 'waiting';
  } else if (lease.isActive) {
    schedulerStatus = 'running';
  }

  return {
    isPaused: state?.isPaused ?? false,
    isStopped: state?.isStopped ?? false,
    todaySentCount: quota.todaySentCount,
    todayDate: quota.todayDate,
    lastSendAt: state?.lastSendAt ?? null,
    lastSendAttemptAt: state?.lastSendAttemptAt ?? null,
    nextSendAt: state?.nextSendAt ?? null,
    timezone: tz,
    dailyLimit: quota.dailyLimit,
    intervalMinutes: state?.intervalMinutes ?? 3,
    startHour,
    startMinute,
    workerId: lease.isActive ? lease.workerId : null,
    lockedUntil: lease.isActive ? lease.lockedUntil : null,
    lastHeartbeatAt: state?.lastHeartbeatAt ?? null,
    isDryRun: process.env.OUTREACH_DRY_RUN === 'true',
    schedulerStatus,
  };
}

export function pauseScheduler(): void {
  const db = getDb();
  db.update(schedulerState)
    .set({ isPaused: true })
    .where(eq(schedulerState.id, 'singleton'))
    .run();
}

export function resumeScheduler(): void {
  const db = getDb();
  db.update(schedulerState)
    .set({ isPaused: false, isStopped: false })
    .where(eq(schedulerState.id, 'singleton'))
    .run();
}

export function stopScheduler(): void {
  const db = getDb();
  db.update(schedulerState)
    .set({ isStopped: true, isPaused: false })
    .where(eq(schedulerState.id, 'singleton'))
    .run();
}

export function getAppSettings(): AppSettings {
  const db = getDb();

  const gmailConnected = db.select().from(settings).where(eq(settings.key, 'gmail_connected')).get();
  const gmailEmail = db.select().from(settings).where(eq(settings.key, 'gmail_email')).get();
  const currentResume = db.select().from(resume).where(eq(resume.id, 'current')).get();
  const scheduler = getSchedulerConfig();

  let profile = null;
  if (currentResume?.parsedData) {
    try {
      profile = JSON.parse(currentResume.parsedData);
    } catch {
      // ignore
    }
  }

  return {
    gmailConnected: gmailConnected?.value === 'true',
    gmailEmail: gmailEmail?.value ?? '',
    scheduler,
    resumeUploaded: !!currentResume,
    resumeFilename: currentResume?.filename ?? null,
    resumeVersion: currentResume?.version ?? null,
    resumeProfile: profile,
  };
}

export function updateSetting(key: string, value: string): void {
  const db = getDb();
  db.insert(settings)
    .values({ key, value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date().toISOString() },
    })
    .run();
}

export function updateSchedulerConfig(updates: Partial<SchedulerConfig>): void {
  const db = getDb();
  const updateData: Record<string, unknown> = {};

  if (updates.isPaused !== undefined) updateData.isPaused = updates.isPaused;
  if (updates.isStopped !== undefined) updateData.isStopped = updates.isStopped;
  if (updates.timezone !== undefined) updateData.timezone = updates.timezone;
  if (updates.dailyLimit !== undefined) updateData.dailyLimit = updates.dailyLimit;
  if (updates.intervalMinutes !== undefined) updateData.intervalMinutes = updates.intervalMinutes;
  if (updates.startHour !== undefined) updateData.startHour = updates.startHour;
  if (updates.startMinute !== undefined) updateData.startMinute = updates.startMinute;

  if (Object.keys(updateData).length > 0) {
    db.update(schedulerState)
      .set(updateData)
      .where(eq(schedulerState.id, 'singleton'))
      .run();
  }
}
