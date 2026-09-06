import { getDb } from './index';
import { schedulerState, settings } from './schema';

export function seedDatabase() {
  const db = getDb();

  // Insert default scheduler state if not exists
  db.insert(schedulerState)
    .values({
      id: 'singleton',
      isPaused: false,
      todaySentCount: 0,
      todayDate: new Date().toISOString().split('T')[0],
      timezone: 'Asia/Kolkata',
      dailyLimit: 30,
      intervalMinutes: 3,
      startHour: 10,
      startMinute: 0,
      endHour: 16,
      endMinute: 0,
    })
    .onConflictDoNothing()
    .run();

  // Insert default settings if not exists
  const defaults: Array<{ key: string; value: string }> = [
    { key: 'gmail_connected', value: 'false' },
    { key: 'gmail_email', value: '' },
    { key: 'app_initialized', value: 'true' },
  ];

  for (const setting of defaults) {
    db.insert(settings)
      .values({
        key: setting.key,
        value: setting.value,
      })
      .onConflictDoNothing()
      .run();
  }
}
