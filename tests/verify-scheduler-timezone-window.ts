import assert from 'assert';
import path from 'path';
import fs from 'fs';

const TEST_DIR = path.join(process.cwd(), 'data', `test-tz-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.OUTREACH_DRY_RUN = 'true';

import {
  isWithinDailyWindow,
  getLocalHourAndMinute,
  getNextDailyWindowDate,
  getConfiguredTimezone,
} from '../src/lib/scheduler/time-utils';
import { getDb, resetDbConnection } from '../src/db';
import { initializeDatabase } from '../src/db/migrate';
import { getSchedulerConfig, getDashboardStats } from '../src/lib/db-helpers';

async function runRegressionSuite() {
  console.log('======================================================================');
  console.log('VERIFY SCHEDULER TIMEZONE & SENDING WINDOW CALCULATION');
  console.log('======================================================================\n');

  // Test 1: Configured Timezone Fallback & Resolution
  console.log('1. Checking configured timezone resolution...');
  const defaultTz = getConfiguredTimezone();
  assert.strictEqual(defaultTz, 'Asia/Kolkata', 'Default timezone must be Asia/Kolkata');
  console.log('   ✓ Configured timezone resolved to Asia/Kolkata\n');

  // Test 2: Boundary Precision in Asia/Kolkata (UTC +05:30)
  // 10:00:00 AM IST = 04:30:00 UTC
  // 04:00:00 PM IST = 16:00:00 IST = 10:30:00 UTC
  console.log('2. Verifying exact boundary conditions (10:00:00 AM - 4:00:00 PM IST)...');

  // 09:59:59 IST -> 04:29:59 UTC -> CLOSED (false)
  const t095959 = new Date('2026-09-12T04:29:59.000Z');
  const hm095959 = getLocalHourAndMinute(t095959, 'Asia/Kolkata');
  assert.strictEqual(hm095959.hour, 9, 'Hour must be 9');
  assert.strictEqual(hm095959.minute, 59, 'Minute must be 59');
  assert.strictEqual(hm095959.second, 59, 'Second must be 59');
  assert.strictEqual(isWithinDailyWindow(t095959, 'Asia/Kolkata', 10, 0, 16, 0), false, '09:59:59 IST must be CLOSED');
  console.log('   ✓ 09:59:59 IST evaluates to CLOSED (false)');

  // 10:00:00 IST -> 04:30:00 UTC -> OPEN (true)
  const t100000 = new Date('2026-09-12T04:30:00.000Z');
  const hm100000 = getLocalHourAndMinute(t100000, 'Asia/Kolkata');
  assert.strictEqual(hm100000.hour, 10, 'Hour must be 10');
  assert.strictEqual(hm100000.minute, 0, 'Minute must be 0');
  assert.strictEqual(hm100000.second, 0, 'Second must be 0');
  assert.strictEqual(isWithinDailyWindow(t100000, 'Asia/Kolkata', 10, 0, 16, 0), true, '10:00:00 IST must be OPEN');
  console.log('   ✓ 10:00:00 IST evaluates to OPEN (true)');

  // 15:45:00 IST (3:45 PM IST - the exact user reported scenario) -> 10:15:00 UTC -> OPEN (true)
  const t154500 = new Date('2026-09-12T10:15:00.000Z');
  const hm154500 = getLocalHourAndMinute(t154500, 'Asia/Kolkata');
  assert.strictEqual(hm154500.hour, 15, 'Hour must be 15 (3 PM)');
  assert.strictEqual(hm154500.minute, 45, 'Minute must be 45');
  assert.strictEqual(isWithinDailyWindow(t154500, 'Asia/Kolkata', 10, 0, 16, 0), true, '15:45:00 IST must be OPEN');
  console.log('   ✓ 15:45:00 IST (3:45 PM IST reported scenario) evaluates to OPEN (true)');

  // 15:59:59 IST -> 10:29:59 UTC -> OPEN (true)
  const t155959 = new Date('2026-09-12T10:29:59.000Z');
  const hm155959 = getLocalHourAndMinute(t155959, 'Asia/Kolkata');
  assert.strictEqual(hm155959.hour, 15, 'Hour must be 15');
  assert.strictEqual(hm155959.minute, 59, 'Minute must be 59');
  assert.strictEqual(hm155959.second, 59, 'Second must be 59');
  assert.strictEqual(isWithinDailyWindow(t155959, 'Asia/Kolkata', 10, 0, 16, 0), true, '15:59:59 IST must be OPEN');
  console.log('   ✓ 15:59:59 IST evaluates to OPEN (true)');

  // 16:00:00 IST -> 10:30:00 UTC -> CLOSED (false)
  const t160000 = new Date('2026-09-12T10:30:00.000Z');
  const hm160000 = getLocalHourAndMinute(t160000, 'Asia/Kolkata');
  assert.strictEqual(hm160000.hour, 16, 'Hour must be 16');
  assert.strictEqual(hm160000.minute, 0, 'Minute must be 0');
  assert.strictEqual(hm160000.second, 0, 'Second must be 0');
  assert.strictEqual(isWithinDailyWindow(t160000, 'Asia/Kolkata', 10, 0, 16, 0), false, '16:00:00 IST must be CLOSED');
  console.log('   ✓ 16:00:00 IST evaluates to CLOSED (false)\n');

  // Test 3: Midnight & Non-Window Edge Cases
  console.log('3. Verifying midnight and off-hours...');
  // 00:00:00 IST -> 18:30:00 UTC (previous day)
  const tMidnight = new Date('2026-09-11T18:30:00.000Z');
  const hmMidnight = getLocalHourAndMinute(tMidnight, 'Asia/Kolkata');
  assert.strictEqual(hmMidnight.hour, 0, 'Hour at midnight must be 0');
  assert.strictEqual(hmMidnight.minute, 0, 'Minute at midnight must be 0');
  assert.strictEqual(isWithinDailyWindow(tMidnight, 'Asia/Kolkata', 10, 0, 16, 0), false, 'Midnight IST must be CLOSED');
  console.log('   ✓ 00:00:00 IST evaluates to CLOSED (false) with hour 0');

  // 21:30:00 IST (9:30 PM IST) -> 16:00:00 UTC -> CLOSED
  const tNight = new Date('2026-09-12T16:00:00.000Z');
  assert.strictEqual(isWithinDailyWindow(tNight, 'Asia/Kolkata', 10, 0, 16, 0), false, '21:30:00 IST must be CLOSED');
  console.log('   ✓ 21:30:00 IST evaluates to CLOSED (false)\n');

  // Test 4: Host TZ Invariance
  console.log('4. Verifying invariance across host machine timezones...');
  const hostTimezones = ['UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'Australia/Sydney'];
  const testTimestamps = [
    { date: t095959, expected: false, label: '09:59:59 IST' },
    { date: t100000, expected: true, label: '10:00:00 IST' },
    { date: t154500, expected: true, label: '15:45:00 IST (3:45 PM)' },
    { date: t155959, expected: true, label: '15:59:59 IST' },
    { date: t160000, expected: false, label: '16:00:00 IST' },
  ];

  const originalTz = process.env.TZ;
  try {
    for (const tz of hostTimezones) {
      process.env.TZ = tz;
      for (const item of testTimestamps) {
        const result = isWithinDailyWindow(item.date, 'Asia/Kolkata', 10, 0, 16, 0);
        assert.strictEqual(
          result,
          item.expected,
          `With process.env.TZ=${tz}, ${item.label} expected ${item.expected} but got ${result}`
        );
      }
      console.log(`   ✓ Invariant when host TZ is set to ${tz}`);
    }
  } finally {
    process.env.TZ = originalTz;
  }
  console.log('   ✓ All test timestamps are 100% invariant to host machine timezone.\n');

  // Test 5: Next Window Calculation
  console.log('5. Verifying getNextDailyWindowDate...');
  // If tested at 09:00:00 IST -> next window should be today at 10:00:00 IST
  const t090000 = new Date('2026-09-12T03:30:00.000Z');
  const nextFromMorning = getNextDailyWindowDate(t090000, 'Asia/Kolkata', 10, 0, 16, 0);
  assert.strictEqual(
    nextFromMorning.toISOString(),
    '2026-09-12T04:30:00.000Z',
    'Next window from 9:00 AM IST must be today at 10:00 AM IST (04:30 UTC)'
  );

  // If tested at 16:30:00 IST -> next window should be tomorrow at 10:00:00 IST
  const t163000 = new Date('2026-09-12T11:00:00.000Z');
  const nextFromEvening = getNextDailyWindowDate(t163000, 'Asia/Kolkata', 10, 0, 16, 0);
  assert.strictEqual(
    nextFromEvening.toISOString(),
    '2026-09-13T04:30:00.000Z',
    'Next window from 4:30 PM IST must be tomorrow at 10:00 AM IST (04:30 UTC next day)'
  );
  console.log('   ✓ getNextDailyWindowDate computes accurate next window timestamps.\n');

  // Test 6: DB Helpers & Scheduler Config Integration
  console.log('6. Verifying getSchedulerConfig and getDashboardStats expose isWindowOpen...');
  resetDbConnection();
  initializeDatabase();

  const schedulerConfig = getSchedulerConfig();
  assert.strictEqual(typeof schedulerConfig.isWindowOpen, 'boolean', 'schedulerConfig.isWindowOpen must be boolean');
  assert.strictEqual(schedulerConfig.timezone, 'Asia/Kolkata', 'schedulerConfig.timezone must be Asia/Kolkata');

  const stats = getDashboardStats();
  assert.strictEqual(typeof stats.isWindowOpen, 'boolean', 'stats.isWindowOpen must be boolean');
  console.log(`   ✓ isWindowOpen exposed cleanly: ${schedulerConfig.isWindowOpen} (schedulerStatus: ${schedulerConfig.schedulerStatus})\n`);

  console.log('======================================================================');
  console.log('ALL SCHEDULER TIMEZONE & WINDOW REGRESSION TESTS PASSED!');
  console.log('======================================================================\n');
}

runRegressionSuite()
  .catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  })
  .finally(() => {
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });
