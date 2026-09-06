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
 * Determines whether the given time is within the daily sending window (default: 10:00 AM to 4:00 PM IST).
 */
export function isWithinDailyWindow(
  date: Date = new Date(),
  timezone: string = getConfiguredTimezone(),
  startHour: number = 10,
  startMinute: number = 0,
  endHour: number = 16,
  endMinute: number = 0
): boolean {
  const { hour, minute } = getLocalHourAndMinute(date, timezone);
  const currentMinutes = hour * 60 + minute;
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

/**
 * Computes the Date representing the next occurrence of startHour:startMinute in the given timezone.
 * If currently before start window today, returns today's window start.
 * If currently at or after start window (or after 4 PM end window), returns tomorrow's window start.
 */
export function getNextDailyWindowDate(
  now: Date = new Date(),
  timezone: string = getConfiguredTimezone(),
  startHour: number = 10,
  startMinute: number = 0,
  endHour: number = 16,
  endMinute: number = 0
): Date {
  const { hour, minute, second } = getLocalHourAndMinute(now, timezone);

  const currentSeconds = hour * 3600 + minute * 60 + second;
  const startSeconds = startHour * 3600 + startMinute * 60;

  let secondsUntilTarget: number;
  if (currentSeconds < startSeconds) {
    // Today's window start is still in the future
    secondsUntilTarget = startSeconds - currentSeconds;
  } else {
    // Today's window has already passed or is underway, schedule for tomorrow's window
    const secondsInDay = 86400;
    secondsUntilTarget = secondsInDay - currentSeconds + startSeconds;
  }

  const result = new Date(now.getTime() + secondsUntilTarget * 1000);
  result.setMilliseconds(0);
  return result;
}

/**
 * Global Email Cooldown Policy:
 * Confirmed successful real sends block an email address for exactly 6 full days (144 elapsed hours).
 */
export const EMAIL_COOLDOWN_HOURS = 144;
export const EMAIL_COOLDOWN_MS = EMAIL_COOLDOWN_HOURS * 60 * 60 * 1000; // 518,400,000 ms

/**
 * Checks whether an email address is currently within the 144-hour cooldown from its last confirmed real send.
 */
export function isEmailInCooldown(sentAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!sentAt) return false;
  const sentTime = new Date(sentAt).getTime();
  if (isNaN(sentTime)) return false;
  const elapsedMs = now - sentTime;
  return elapsedMs >= 0 && elapsedMs < EMAIL_COOLDOWN_MS;
}

/**
 * Computes remaining cooldown in milliseconds, or 0 if expired / not in cooldown.
 */
export function getCooldownRemainingMs(sentAt: string | null | undefined, now: number = Date.now()): number {
  if (!sentAt) return 0;
  const sentTime = new Date(sentAt).getTime();
  if (isNaN(sentTime)) return 0;
  return Math.max(0, sentTime + EMAIL_COOLDOWN_MS - now);
}

/**
 * Returns the exact Date when the 144-hour cooldown expires for a given sentAt timestamp.
 */
export function getCooldownExpiresAt(sentAt: string | null | undefined): Date | null {
  if (!sentAt) return null;
  const sentTime = new Date(sentAt).getTime();
  if (isNaN(sentTime)) return null;
  return new Date(sentTime + EMAIL_COOLDOWN_MS);
}

/**
 * Returns the ISO cutoff timestamp. Any email whose sent_at is after this cutoff is in active cooldown.
 * Any email sent at or before this cutoff has elapsed its 144-hour cooldown and is eligible again.
 */
export function getCooldownCutoffIso(now: number = Date.now()): string {
  return new Date(now - EMAIL_COOLDOWN_MS).toISOString();
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
 * Computes the next eligible send timestamp (ISO string) given current state and window.
 */
export function computeNextEligibleSendTime(options: {
  lastSendAttemptAt: string | null;
  intervalMinutes: number;
  timezone: string;
  startHour: number;
  startMinute: number;
  endHour?: number;
  endMinute?: number;
  todaySentCount?: number;
  dailyLimit?: number;
  now?: Date;
}): string {
  const {
    lastSendAttemptAt,
    intervalMinutes,
    timezone,
    startHour,
    startMinute,
    endHour = 16,
    endMinute = 0,
    now = new Date(),
  } = options;

  // 1. If outside daily sending window, schedule for the next start window (10:00 AM)
  if (!isWithinDailyWindow(now, timezone, startHour, startMinute, endHour, endMinute)) {
    const nextWindow = getNextDailyWindowDate(now, timezone, startHour, startMinute, endHour, endMinute);
    return nextWindow.toISOString();
  }

  // 2. If within window, ensure interval from last send attempt has elapsed
  if (lastSendAttemptAt) {
    const lastAttemptTime = new Date(lastSendAttemptAt).getTime();
    if (!isNaN(lastAttemptTime)) {
      const earliestNext = lastAttemptTime + intervalMinutes * 60 * 1000;
      if (earliestNext > now.getTime()) {
        const earliestDate = new Date(earliestNext);
        if (!isWithinDailyWindow(earliestDate, timezone, startHour, startMinute, endHour, endMinute)) {
          return getNextDailyWindowDate(earliestDate, timezone, startHour, startMinute, endHour, endMinute).toISOString();
        }
        return earliestDate.toISOString();
      }
    }
  }

  // Eligible right now
  return now.toISOString();
}
