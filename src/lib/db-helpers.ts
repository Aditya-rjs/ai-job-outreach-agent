import { getDb } from '@/db';
import { contacts, outreachQueue, schedulerState, resume, settings } from '@/db/schema';
import { eq, sql, count } from 'drizzle-orm';
import type { DashboardStats, SchedulerConfig, AppSettings } from '@/types';
import { getCandidateProfile } from '@/lib/candidate-profile/candidate-profile-service';
import { isLeaseActive } from '@/lib/scheduler/worker-lease';
import {
  reconcileDailyQuota,
} from '@/lib/scheduler/queue-manager';
import {
  isWithinDailyWindow,
  getConfiguredTimezone,
} from '@/lib/scheduler/time-utils';
import { getGeminiTelemetry } from '@/lib/ai/gemini-client';
import { getAiDispatcherTelemetry } from '@/lib/ai/ai-dispatcher';

import {
  getTotalCompaniesCount,
  getRelevantCompaniesCount,
  getTotalContactsCount,
  getEligibleQueuedCount,
  getEmailsGeneratedCount,
  getEmailsSentCount,
  getEmailsSkippedCount,
} from './dashboard-queries';


export function getDashboardStats(): DashboardStats {
  const db = getDb();

  // Reconcile quota first
  const quota = reconcileDailyQuota();

  const isDryRun = process.env.OUTREACH_DRY_RUN === 'true';

  // Canonical 7-card statistics (Single Source of Truth)
  const totalCompanies = getTotalCompaniesCount();
  const relevantCompanies = getRelevantCompaniesCount();
  const totalContacts = getTotalContactsCount();
  const emailsQueued = getEligibleQueuedCount();
  const emailsGenerated = getEmailsGeneratedCount();
  const emailsSent = getEmailsSentCount(false);
  const emailsSimulated = getEmailsSentCount(true);
  const emailsSkipped = getEmailsSkippedCount();

  // Aggregate secondary generation metrics
  const contactStats = db
    .select({
      emailsFailed: sql<number>`SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)`,
      emailsPendingGeneration: sql<number>`SUM(CASE WHEN generation_status = 'PENDING_GENERATION' OR (is_relevant = 1 AND email_valid = 1 AND is_duplicate = 0 AND status = 'queued' AND (email_body IS NULL OR generation_status IS NULL)) THEN 1 ELSE 0 END)`,
      emailsGenerating: sql<number>`SUM(CASE WHEN generation_status = 'GENERATING' OR status = 'generating' THEN 1 ELSE 0 END)`,
      emailsGenerationRetryPending: sql<number>`SUM(CASE WHEN generation_status = 'RETRY_PENDING' THEN 1 ELSE 0 END)`,
      emailsGenerationFailed: sql<number>`SUM(CASE WHEN generation_status = 'GENERATION_FAILED' THEN 1 ELSE 0 END)`,
      emailsUncertain: sql<number>`SUM(CASE WHEN status = 'uncertain' THEN 1 ELSE 0 END)`,
    })
    .from(contacts)
    .where(sql`contacts.batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')`)
    .get() ?? {
    emailsFailed: 0,
    emailsPendingGeneration: 0,
    emailsGenerating: 0,
    emailsGenerationRetryPending: 0,
    emailsGenerationFailed: 0,
    emailsUncertain: 0,
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
  const todaySimulatedCount = quota.todaySimulatedCount;
  const dailyLimit = quota.dailyLimit;
  const isPaused = scheduler?.isPaused ?? false;
  const isStopped = scheduler?.isStopped ?? false;
  const timezone = scheduler?.timezone ?? getConfiguredTimezone();
  const startHour = scheduler?.startHour ?? 10;
  const startMinute = scheduler?.startMinute ?? 0;
  const endHour = scheduler?.endHour ?? 16;
  const endMinute = scheduler?.endMinute ?? 0;

  const lease = isLeaseActive();
  const isWithinWindow = isWithinDailyWindow(new Date(), timezone, startHour, startMinute, endHour, endMinute);

  let outreachStatus: DashboardStats['outreachStatus'] = 'idle';
  if (isStopped) {
    outreachStatus = 'stopped';
  } else if (isPaused) {
    outreachStatus = 'paused';
  } else if (queueSize > 0 && !isWithinWindow) {
    outreachStatus = 'waiting';
  } else if (queueSize > 0 && lease.isActive) {
    outreachStatus = 'sending';
  } else if (queueSize > 0) {
    outreachStatus = 'running';
  } else if (((emailsSent > 0) || (emailsSimulated > 0)) && queueSize === 0) {
    outreachStatus = 'completed';
  }

  const gmailConnected = db.select().from(settings).where(eq(settings.key, 'gmail_connected')).get();
  const gmailEmail = db.select().from(settings).where(eq(settings.key, 'gmail_email')).get();

  return {
    totalCompanies,
    relevantCompanies,
    totalContacts,
    emailsSent,
    emailsSimulated,
    emailsFailed: contactStats.emailsFailed ?? 0,
    emailsQueued,
    emailsGenerated,
    emailsPendingGeneration: contactStats.emailsPendingGeneration ?? 0,
    emailsGenerating: contactStats.emailsGenerating ?? 0,
    emailsGenerationRetryPending: contactStats.emailsGenerationRetryPending ?? 0,
    emailsGenerationFailed: contactStats.emailsGenerationFailed ?? 0,
    emailsSkipped,
    emailsUncertain: contactStats.emailsUncertain ?? 0,
    todaySentCount,
    todaySimulatedCount,
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
    geminiTelemetry: getGeminiTelemetry(),
    aiTelemetry: getAiDispatcherTelemetry(),
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
  const endHour = state?.endHour ?? 16;
  const endMinute = state?.endMinute ?? 0;
  const isWithinWindow = isWithinDailyWindow(new Date(), tz, startHour, startMinute, endHour, endMinute);
  const lease = isLeaseActive();

  let schedulerStatus: SchedulerConfig['schedulerStatus'] = 'waiting';
  if (state?.isStopped) {
    schedulerStatus = 'stopped';
  } else if (state?.isPaused) {
    schedulerStatus = 'paused';
  } else if (!isWithinWindow) {
    schedulerStatus = 'waiting';
  } else if (lease.isActive) {
    schedulerStatus = 'running';
  }

  return {
    isPaused: state?.isPaused ?? false,
    isStopped: state?.isStopped ?? false,
    todaySentCount: quota.todaySentCount,
    todaySimulatedCount: quota.todaySimulatedCount,
    todayDate: quota.todayDate,
    lastSendAt: state?.lastSendAt ?? null,
    lastSendAttemptAt: state?.lastSendAttemptAt ?? null,
    nextSendAt: state?.nextSendAt ?? null,
    timezone: tz,
    dailyLimit: quota.dailyLimit,
    intervalMinutes: state?.intervalMinutes ?? 3,
    startHour,
    startMinute,
    endHour,
    endMinute,
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
    candidateProfile: getCandidateProfile(db),
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
  if (updates.endHour !== undefined) updateData.endHour = updates.endHour;
  if (updates.endMinute !== undefined) updateData.endMinute = updates.endMinute;

  if (Object.keys(updateData).length > 0) {
    db.update(schedulerState)
      .set(updateData)
      .where(eq(schedulerState.id, 'singleton'))
      .run();
  }
}
