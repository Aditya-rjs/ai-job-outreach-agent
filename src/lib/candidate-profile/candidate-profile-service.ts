import { getDb, type DbClient } from '@/db';
import { candidateProfile, settings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { invalidateStaleResumeContacts } from '@/lib/scheduler/queue-manager';
import type { CandidateProfile, CandidateEducation, CandidateExperience, CandidateProject, CandidateSkills, CandidateAchievement } from '@/types';

const DEFAULT_SKILLS: CandidateSkills = {
  languages: [],
  frameworks: [],
  databases: [],
  cloudDevOps: [],
  tools: [],
  other: [],
};

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
    education = JSON.parse(row.education || '[]');
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
    skills = {
      languages: Array.isArray(parsedSkills.languages) ? parsedSkills.languages : [],
      frameworks: Array.isArray(parsedSkills.frameworks) ? parsedSkills.frameworks : [],
      databases: Array.isArray(parsedSkills.databases) ? parsedSkills.databases : [],
      cloudDevOps: Array.isArray(parsedSkills.cloudDevOps) ? parsedSkills.cloudDevOps : [],
      tools: Array.isArray(parsedSkills.tools) ? parsedSkills.tools : [],
      other: Array.isArray(parsedSkills.other) ? parsedSkills.other : [],
    };
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

  const nextEducation = updates.education !== undefined ? updates.education : current.education;
  const nextExperience = updates.experience !== undefined ? updates.experience : current.experience;
  const nextProjects = updates.projects !== undefined ? updates.projects : current.projects;
  const nextSkills = updates.skills !== undefined ? updates.skills : current.skills;
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
      (profile.skills.languages?.length ?? 0) > 0 ||
      (profile.skills.frameworks?.length ?? 0) > 0 ||
      (profile.skills.databases?.length ?? 0) > 0 ||
      (profile.skills.tools?.length ?? 0) > 0
    )
  );

  return hasName || hasEdu || hasExp || hasProj || hasSkills;
}
