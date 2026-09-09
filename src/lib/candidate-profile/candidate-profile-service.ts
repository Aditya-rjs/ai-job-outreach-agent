import { getDb, type DbClient } from '@/db';
import { candidateProfile, settings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { invalidateStaleResumeContacts } from '@/lib/scheduler/queue-manager';
import type { CandidateProfile, CandidateEducation, CandidateExperience, CandidateProject, CandidateSkills, CandidateAchievement } from '@/types';

const DEFAULT_SKILLS: CandidateSkills = {
  programmingLanguages: [],
  webDevelopment: [],
  databasesOrms: [],
  aiMl: [],
  coreComputerScience: [],
  toolsApis: [],
};

function sanitizeCandidateSkills(rawSkills: unknown): CandidateSkills {
  if (!rawSkills || typeof rawSkills !== 'object') {
    return { ...DEFAULT_SKILLS };
  }
  const s = rawSkills as Record<string, unknown>;
  const cleanArray = (val: unknown): string[] => {
    if (!Array.isArray(val)) return [];
    return val.map((x) => String(x).trim()).filter(Boolean);
  };
  return {
    programmingLanguages: cleanArray(s.programmingLanguages),
    webDevelopment: cleanArray(s.webDevelopment),
    databasesOrms: cleanArray(s.databasesOrms),
    aiMl: cleanArray(s.aiMl),
    coreComputerScience: cleanArray(s.coreComputerScience),
    toolsApis: cleanArray(s.toolsApis),
  };
}

function sanitizeCandidateEducation(rawList: unknown[]): CandidateEducation[] {
  if (!Array.isArray(rawList)) return [];
  return rawList.map((e: any) => {
    const item: CandidateEducation = {
      id: typeof e.id === 'string' && e.id ? e.id : `edu_${Date.now()}`,
      institution: typeof e.institution === 'string' ? e.institution.trim() : '',
      degree: typeof e.degree === 'string' ? e.degree.trim() : '',
    };
    if (typeof e.fieldOfStudy === 'string' && e.fieldOfStudy.trim()) {
      item.fieldOfStudy = e.fieldOfStudy.trim();
    }
    if (typeof e.year === 'string' && e.year.trim()) {
      item.year = e.year.trim();
    }
    if (Array.isArray(e.highlights)) {
      item.highlights = e.highlights.map((h: unknown) => String(h).trim()).filter(Boolean);
    }
    return item;
  });
}

export function getCandidateProfile(dbClient?: DbClient): CandidateProfile {
  const db = dbClient || getDb();
  let row = db.select().from(candidateProfile).where(eq(candidateProfile.id, 'singleton')).get();

  if (!row) {
    // Seed singleton row if not present, preserving existing manual links from settings if any
    const linkLinkedin = db.select().from(settings).where(eq(settings.key, 'profile_link_linkedin')).get()?.value || '';
    const linkGithub = db.select().from(settings).where(eq(settings.key, 'profile_link_github')).get()?.value || '';
    const linkPortfolio = db.select().from(settings).where(eq(settings.key, 'profile_link_portfolio')).get()?.value || '';

    const defaultSkillsJson = JSON.stringify(DEFAULT_SKILLS);
    const nowIso = new Date().toISOString();

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
        education: '[]',
        experience: '[]',
        projects: '[]',
        skills: defaultSkillsJson,
        achievements: '[]',
        version: '1',
        updatedAt: nowIso,
      })
      .onConflictDoNothing()
      .run();

    row = db.select().from(candidateProfile).where(eq(candidateProfile.id, 'singleton')).get();
  }

  if (!row) {
    throw new Error('Failed to retrieve or initialize candidate_profile singleton');
  }

  let education: CandidateEducation[] = [];
  try {
    education = sanitizeCandidateEducation(JSON.parse(row.education || '[]'));
  } catch {
    education = [];
  }

  let experience: CandidateExperience[] = [];
  try {
    experience = JSON.parse(row.experience || '[]');
  } catch {
    experience = [];
  }

  let projects: CandidateProject[] = [];
  try {
    projects = JSON.parse(row.projects || '[]');
  } catch {
    projects = [];
  }

  let skills: CandidateSkills = { ...DEFAULT_SKILLS };
  try {
    const parsedSkills = JSON.parse(row.skills || '{}');
    skills = sanitizeCandidateSkills(parsedSkills);
  } catch {
    skills = { ...DEFAULT_SKILLS };
  }

  let achievements: CandidateAchievement[] = [];
  try {
    achievements = JSON.parse(row.achievements || '[]');
  } catch {
    achievements = [];
  }

  return {
    fullName: row.fullName || '',
    email: row.email || '',
    phone: row.phone || '',
    degree: row.degree || '',
    fieldOfStudy: row.fieldOfStudy || '',
    institution: row.institution || '',
    graduationYear: row.graduationYear || '',
    linkedin: row.linkedin || '',
    github: row.github || '',
    portfolio: row.portfolio || '',
    education,
    experience,
    projects,
    skills,
    achievements,
    version: row.version || '1',
    updatedAt: row.updatedAt || new Date().toISOString(),
  };
}

export function saveCandidateProfile(
  updates: Partial<CandidateProfile>,
  dbClient?: DbClient
): CandidateProfile {
  const db = dbClient || getDb();
  const current = getCandidateProfile(db);
  const nowIso = new Date().toISOString();
  const newVersion = Date.now().toString();

  const nextFullName = updates.fullName !== undefined ? updates.fullName.trim() : current.fullName;
  const nextEmail = updates.email !== undefined ? updates.email.trim() : current.email;
  const nextPhone = updates.phone !== undefined ? updates.phone.trim() : current.phone;
  const nextDegree = updates.degree !== undefined ? updates.degree.trim() : current.degree;
  const nextFieldOfStudy = updates.fieldOfStudy !== undefined ? updates.fieldOfStudy.trim() : current.fieldOfStudy;
  const nextInstitution = updates.institution !== undefined ? updates.institution.trim() : current.institution;
  const nextGraduationYear = updates.graduationYear !== undefined ? updates.graduationYear.trim() : current.graduationYear;

  const nextLinkedin = updates.linkedin !== undefined ? updates.linkedin.trim() : current.linkedin;
  const nextGithub = updates.github !== undefined ? updates.github.trim() : current.github;
  const nextPortfolio = updates.portfolio !== undefined ? updates.portfolio.trim() : current.portfolio;

  const nextEducation = updates.education !== undefined
    ? sanitizeCandidateEducation(updates.education)
    : current.education;
  const nextExperience = updates.experience !== undefined ? updates.experience : current.experience;
  const nextProjects = updates.projects !== undefined ? updates.projects : current.projects;
  const nextSkills = updates.skills !== undefined
    ? sanitizeCandidateSkills(updates.skills)
    : current.skills;
  const nextAchievements = updates.achievements !== undefined ? updates.achievements : current.achievements;

  db.update(candidateProfile)
    .set({
      fullName: nextFullName,
      email: nextEmail,
      phone: nextPhone,
      degree: nextDegree,
      fieldOfStudy: nextFieldOfStudy,
      institution: nextInstitution,
      graduationYear: nextGraduationYear,
      linkedin: nextLinkedin,
      github: nextGithub,
      portfolio: nextPortfolio,
      education: JSON.stringify(nextEducation),
      experience: JSON.stringify(nextExperience),
      projects: JSON.stringify(nextProjects),
      skills: JSON.stringify(nextSkills),
      achievements: JSON.stringify(nextAchievements),
      version: newVersion,
      updatedAt: nowIso,
    })
    .where(eq(candidateProfile.id, 'singleton'))
    .run();

  // Sync links with settings table for backward compatibility
  const linkPairs = [
    { key: 'profile_link_linkedin', val: nextLinkedin },
    { key: 'profile_link_github', val: nextGithub },
    { key: 'profile_link_portfolio', val: nextPortfolio },
  ];

  for (const { key, val } of linkPairs) {
    db.insert(settings)
      .values({ key, value: val, updatedAt: nowIso })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: val, updatedAt: nowIso },
      })
      .run();
  }

  // Invalidate any un-sent generated contacts that were generated with an older version
  try {
    invalidateStaleResumeContacts(newVersion);
  } catch (err) {
    console.warn('[saveCandidateProfile] Stale contacts invalidation warning:', err);
  }

  return getCandidateProfile(db);
}

export function isCandidateProfileConfigured(profile: CandidateProfile): boolean {
  if (!profile) return false;
  const hasName = Boolean(profile.fullName && profile.fullName.trim());
  const hasEdu = profile.education && profile.education.length > 0;
  const hasExp = profile.experience && profile.experience.length > 0;
  const hasProj = profile.projects && profile.projects.length > 0;
  const hasSkills = Boolean(
    profile.skills && (
      (profile.skills.programmingLanguages?.length ?? 0) > 0 ||
      (profile.skills.webDevelopment?.length ?? 0) > 0 ||
      (profile.skills.databasesOrms?.length ?? 0) > 0 ||
      (profile.skills.aiMl?.length ?? 0) > 0 ||
      (profile.skills.coreComputerScience?.length ?? 0) > 0 ||
      (profile.skills.toolsApis?.length ?? 0) > 0
    )
  );

  return hasName || hasEdu || hasExp || hasProj || hasSkills;
}
