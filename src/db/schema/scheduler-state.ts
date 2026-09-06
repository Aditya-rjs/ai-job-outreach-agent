import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const schedulerState = sqliteTable('scheduler_state', {
  id: text('id').primaryKey().default('singleton'),
  isPaused: integer('is_paused', { mode: 'boolean' }).default(false).notNull(),
  isStopped: integer('is_stopped', { mode: 'boolean' }).default(false).notNull(),
  todaySentCount: integer('today_sent_count').default(0).notNull(),
  todaySimulatedCount: integer('today_simulated_count').default(0).notNull(),
  todayDate: text('today_date'),
  lastSendAt: text('last_send_at'),
  lastSendAttemptAt: text('last_send_attempt_at'),
  nextSendAt: text('next_send_at'),
  timezone: text('timezone').default('Asia/Kolkata').notNull(),
  dailyLimit: integer('daily_limit').default(30).notNull(),
  intervalMinutes: integer('interval_minutes').default(3).notNull(),
  startHour: integer('start_hour').default(10).notNull(),
  startMinute: integer('start_minute').default(0).notNull(),
  endHour: integer('end_hour').default(16).notNull(),
  endMinute: integer('end_minute').default(0).notNull(),
  workerId: text('worker_id'),
  lockedUntil: text('locked_until'),
  lastHeartbeatAt: text('last_heartbeat_at'),
});
