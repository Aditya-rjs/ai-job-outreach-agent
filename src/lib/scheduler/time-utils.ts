import { env } from '@/lib/config/env';

/**
 * Validates whether a timezone identifier is valid.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Gets the configured timezone, falling back to 'Asia/Kolkata'.
 */
export function getConfiguredTimezone(): string {
  const tz = env.timezone();
  return isValidTimezone(tz) ? tz : 'Asia/Kolkata';
}

/**
 * Returns the calendar date string (YYYY-MM-DD) for a given Date in the target timezone.
 */
export function getLocalDateString(date: Date = new Date(), timezone: string = getConfiguredTimezone()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date); // en-CA formats as YYYY-MM-DD
}

/**
 * Returns the current hour and minute in the target timezone.
 */
export function getLocalHourAndMinute(
  date: Date = new Date(),
  timezone: string = getConfiguredTimezone()
): { hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  }).formatToParts(date);

  let hour = 0;
  let minute = 0;
  let second = 0;

  for (const part of parts) {
    if (part.type === 'hour') hour = parseInt(part.value, 10);
    if (part.type === 'minute') minute = parseInt(part.value, 10);
    if (part.type === 'second') second = parseInt(part.value, 10);
  }

  return { hour: hour % 24, minute, second };
}

/**
 * Determines whether the given time is on or after the daily sending window start.
 */
export function isWithinDailyWindow(
  date: Date = new Date(),
  timezone: string = getConfiguredTimezone(),
  startHour: number = 10,
  startMinute: number = 0
): boolean {
  const { hour, minute } = getLocalHourAndMinute(date, timezone);
  if (hour > startHour) return true;
  if (hour === startHour && minute >= startMinute) return true;
  return false;
}

/**
 * Computes the Date representing the next occurrence of startHour:startMinute in the given timezone.
 */
export function getNextDailyWindowDate(
  now: Date = new Date(),
  timezone: string = getConfiguredTimezone(),
  startHour: number = 10,
  startMinute: number = 0
): Date {
  const { hour, minute, second } = getLocalHourAndMinute(now, timezone);

  // How many seconds elapsed today until now in local time?
  const currentSeconds = hour * 3600 + minute * 60 + second;
  const targetSeconds = startHour * 3600 + startMinute * 60;

  let secondsUntilTarget: number;
  if (currentSeconds < targetSeconds) {
    // Today's window is still in the future
    secondsUntilTarget = targetSeconds - currentSeconds;
  } else {
    // Today's window has already passed, schedule for tomorrow
    const secondsInDay = 86400;
    secondsUntilTarget = secondsInDay - currentSeconds + targetSeconds;
  }

  return new Date(now.getTime() + secondsUntilTarget * 1000);
}

/**
 * Checks whether the required interval (e.g. 3 minutes) has elapsed since the last send attempt.
 */
export function hasIntervalElapsed(lastSendIso: string | null, intervalMinutes: number = 3): boolean {
  if (!lastSendIso) return true;
  const lastTime = new Date(lastSendIso).getTime();
  if (isNaN(lastTime)) return true;

  const now = Date.now();
  const requiredMs = intervalMinutes * 60 * 1000;
  return now - lastTime >= requiredMs;
}

/**
 * Computes the next eligible send timestamp (ISO string) given current state.
 */
export function computeNextEligibleSendTime(options: {
  lastSendAttemptAt: string | null;
  intervalMinutes: number;
  timezone: string;
  startHour: number;
  startMinute: number;
  todaySentCount: number;
  dailyLimit: number;
  now?: Date;
}): string {
  const {
    lastSendAttemptAt,
    intervalMinutes,
    timezone,
    startHour,
    startMinute,
    todaySentCount,
    dailyLimit,
    now = new Date(),
  } = options;

  // 1. If daily quota already reached, schedule for tomorrow's window
  if (todaySentCount >= dailyLimit) {
    const nextWindow = getNextDailyWindowDate(now, timezone, startHour, startMinute);
    return nextWindow.toISOString();
  }

  // 2. If before today's daily window, schedule for today's start window
  if (!isWithinDailyWindow(now, timezone, startHour, startMinute)) {
    const nextWindow = getNextDailyWindowDate(now, timezone, startHour, startMinute);
    return nextWindow.toISOString();
  }

  // 3. If within window, ensure 3-minute interval from last send attempt has elapsed
  if (lastSendAttemptAt) {
    const lastAttemptTime = new Date(lastSendAttemptAt).getTime();
    if (!isNaN(lastAttemptTime)) {
      const earliestNext = lastAttemptTime + intervalMinutes * 60 * 1000;
      if (earliestNext > now.getTime()) {
        return new Date(earliestNext).toISOString();
      }
    }
  }

  // Eligible right now
  return now.toISOString();
}
