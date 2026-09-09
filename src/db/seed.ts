import { getDb } from './index';
import { schedulerState, settings, aiProviderState, candidateProfile } from './schema';
import { eq } from 'drizzle-orm';

export function seedDatabase() {
  const db = getDb();

  // Insert default AI provider state if not exists
  db.insert(aiProviderState)
    .values({
      id: 'singleton',
      activeProvider: 'gemini',
      geminiCooldownUntil: null,
      geminiLastError: null,
      openrouterCooldownUntil: null,
      openrouterLastError: null,
      totalDispatches: 0,
      geminiSuccesses: 0,
      geminiFailures: 0,
      gemini429Count: 0,
      openrouterDispatches: 0,
      openrouterSuccesses: 0,
      openrouterFailures: 0,
      fallbackCount: 0,
      lastFallbackAt: null,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();

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

  // Ensure candidate_profile singleton exists with clean manual defaults
  // IMPORTANT: Do NOT read resume.parsedData. Only preserve genuinely manual profile_link_* if present.
  const existingProfile = db.select().from(candidateProfile).where(eq(candidateProfile.id, 'singleton')).get();
  if (!existingProfile) {
    const linkLinkedin = db.select().from(settings).where(eq(settings.key, 'profile_link_linkedin')).get()?.value || '';
    const linkGithub = db.select().from(settings).where(eq(settings.key, 'profile_link_github')).get()?.value || '';
    const linkPortfolio = db.select().from(settings).where(eq(settings.key, 'profile_link_portfolio')).get()?.value || '';
    const linkOther = db.select().from(settings).where(eq(settings.key, 'profile_link_other')).get()?.value || '';

    db.insert(candidateProfile)
      .values({
        id: 'singleton',
        fullName: '',
        email: '',
        phone: '',
        degree: '',
        fieldOfStudy: '',
        institution: '',
        graduationYear: '',
        linkedin: linkLinkedin,
        github: linkGithub,
        portfolio: linkPortfolio,
        otherLink: linkOther,
        education: '[]',
        experience: '[]',
        projects: '[]',
        skills: JSON.stringify({
          languages: [],
          frameworks: [],
          databases: [],
          cloudDevOps: [],
          tools: [],
          other: [],
        }),
        achievements: '[]',
        version: '1',
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
  }
}
