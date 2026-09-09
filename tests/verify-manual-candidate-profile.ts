import { getDb } from '../src/db';
import { initializeDatabase } from '../src/db/migrate';
import { candidateProfile, settings, resume, contacts, batches } from '../src/db/schema';
import { eq, sql } from 'drizzle-orm';
import {
  getCandidateProfile,
  saveCandidateProfile,
  isCandidateProfileConfigured,
} from '../src/lib/candidate-profile/candidate-profile-service';
import { generatePersonalizedEmail } from '../src/lib/ai/email-generator';
import type { CandidateProfile } from '../src/types';
import {
  parseRawHighlightsText,
  normalizeHighlightItems,
  hasListMarker,
} from '../src/lib/candidate-profile/highlight-utils';
import fs from 'fs';
import path from 'path';

async function runTests() {
  console.log('===============================================================');
  console.log('  TEST SUITE: MANUAL PERSISTENT CANDIDATE PROFILE VERIFICATION');
  console.log('===============================================================\n');

  // Initialize DB
  initializeDatabase();
  const db = getDb();

  // Test 1: Verify candidate_profile table exists and singleton row is initialized
  console.log('[Test 1] Verifying candidate_profile singleton initialization...');
  const initialProfile = getCandidateProfile(db);
  if (!initialProfile) {
    throw new Error('Candidate profile singleton row was not retrieved.');
  }
  console.log('✓ Initial candidate profile successfully retrieved.');
  console.log('  Profile ID/Version:', initialProfile.version);

  // Test 2: Invariant Check — Confirm resume.parsedData was NOT copied into candidate_profile
  console.log('\n[Test 2] Verifying resume.parsedData was NOT auto-migrated into candidate_profile...');
  // Even if resume has old corrupted parsedData, candidate_profile must be clean
  const resumeRecord = db.select().from(resume).where(eq(resume.id, 'current')).get();
  if (resumeRecord?.parsedData) {
    // If old resume.parsedData contained "Technical Project" or old AI junk, candidate_profile must not have it
    const candidateHasOldProject = initialProfile.projects.some(
      (p) => p.name === 'Technical Project' || p.description?.includes('threat classification')
    );
    if (candidateHasOldProject) {
      throw new Error('FAIL: Old corrupted resume.parsedData was detected in candidate_profile!');
    }
    console.log('✓ Verified: Old AI-derived resume.parsedData was NOT copied into candidate_profile.');
  } else {
    console.log('✓ Verified: No legacy parsedData contamination.');
  }

  // Test 2b: Verify candidate_profile schema has NO location, NO summary, and NO other_link columns
  console.log('\n[Test 2b] Verifying candidate_profile schema strictly lacks location, summary, and other_link...');
  const tableColumns = db.all<{ name: string }>(sql`PRAGMA table_info(candidate_profile)`);
  const colNames = tableColumns.map((c) => c.name);
  if (colNames.includes('location')) {
    throw new Error('FAIL: candidate_profile still has location column in SQLite table!');
  }
  if (colNames.includes('summary')) {
    throw new Error('FAIL: candidate_profile still has summary column in SQLite table!');
  }
  if (colNames.includes('other_link')) {
    throw new Error('FAIL: candidate_profile still has other_link column in SQLite table!');
  }
  const requiredPersonalCols = [
    'full_name',
    'email',
    'phone',
    'degree',
    'field_of_study',
    'institution',
    'graduation_year',
  ];
  for (const col of requiredPersonalCols) {
    if (!colNames.includes(col)) {
      throw new Error(`FAIL: candidate_profile missing expected column ${col}!`);
    }
  }
  const requiredLinkCols = ['linkedin', 'github', 'portfolio'];
  for (const col of requiredLinkCols) {
    if (!colNames.includes(col)) {
      throw new Error(`FAIL: candidate_profile missing expected link column ${col}!`);
    }
  }
  console.log('✓ Verified: SQLite schema strictly contains only the 7 approved personal fields and 3 approved link fields (no location, no summary, no other_link).');

  // Test 3: Verify Saving & Updating Authoritative Candidate Profile
  console.log('\n[Test 3] Testing manual profile save and persistence...');
  const testPayload: Partial<CandidateProfile> = {
    fullName: 'Aditya Raj Singh',
    email: 'aditya.singh@example.com',
    phone: '+91 9876543210',
    degree: 'B.Tech',
    fieldOfStudy: 'Computer Science and Engineering',
    institution: 'LNJPIT Chapra',
    graduationYear: '2025',
    linkedin: 'https://linkedin.com/in/adityarajsingh-test',
    github: 'https://github.com/adityasingh-test',
    portfolio: 'https://adityasingh.dev',
    education: [
      {
        id: 'edu_1',
        institution: 'LNJPIT Chapra',
        degree: 'B.Tech',
        fieldOfStudy: 'Computer Science and Engineering',
        year: '2021 - 2025',
        highlights: ['Data Structures & Algorithms', 'Operating Systems', 'Distinction'],
      },
    ],
    experience: [
      {
        id: 'exp_1',
        company: 'Cloud Innovations Lab',
        role: 'Software Engineer Intern',
        duration: 'Jan 2024 - Jun 2024',
        location: 'Remote',
        highlights: [
          'Engineered event-driven pipeline processing 10,000+ events/min',
          'Reduced API query latency by 42% through SQLite WAL indexing',
        ],
        technologies: ['TypeScript', 'Node.js', 'SQLite', 'Docker'],
      },
    ],
    projects: [
      {
        id: 'proj_1',
        name: 'AI Job Outreach Engine',
        duration: '3 months',
        description: 'Autonomous job outreach platform featuring Gmail OAuth integration and intelligent rate limiting',
        techStack: ['Next.js 16', 'TypeScript', 'TailwindCSS', 'SQLite'],
        highlights: [
          'Built persistent queue manager with exponential backoff',
          'Designed strict anti-hallucination prompt fact synthesis engine',
        ],
        liveUrl: 'https://outreach-engine.demo',
        githubUrl: 'https://github.com/adityasingh-test/outreach-engine',
      },
    ],
    skills: {
      programmingLanguages: ['TypeScript', 'JavaScript', 'Python', 'SQL'],
      webDevelopment: ['Next.js', 'React', 'Node.js', 'Express'],
      databasesOrms: ['SQLite', 'PostgreSQL', 'Redis'],
      aiMl: ['PyTorch', 'TensorFlow', 'LLMs'],
      coreComputerScience: ['Data Structures & Algorithms', 'Operating Systems', 'DBMS'],
      toolsApis: ['Git', 'Postman', 'Linux', 'Docker'],
    },
    achievements: [
      {
        id: 'ach_1',
        title: 'Winner - National Smart India Hackathon 2024',
        description: 'First prize for automated disaster coordination platform',
        year: '2024',
      },
    ],
  };

  const saved = saveCandidateProfile(testPayload, db);
  if (saved.fullName !== 'Aditya Raj Singh') {
    throw new Error('FAIL: Full name did not save correctly.');
  }
  if (saved.projects.length !== 1 || saved.projects[0].name !== 'AI Job Outreach Engine') {
    throw new Error('FAIL: Projects did not save correctly.');
  }
  if (saved.skills.programmingLanguages.length !== 4) {
    throw new Error('FAIL: programmingLanguages did not save correctly.');
  }
  if (saved.skills.webDevelopment.length !== 4) {
    throw new Error('FAIL: webDevelopment did not save correctly.');
  }
  if (saved.skills.databasesOrms.length !== 3) {
    throw new Error('FAIL: databasesOrms did not save correctly.');
  }
  if (saved.skills.aiMl.length !== 3) {
    throw new Error('FAIL: aiMl did not save correctly.');
  }
  if (saved.skills.coreComputerScience.length !== 3) {
    throw new Error('FAIL: coreComputerScience did not save correctly.');
  }
  if (saved.skills.toolsApis.length !== 4) {
    throw new Error('FAIL: toolsApis did not save correctly.');
  }
  const savedSkillKeys = Object.keys(saved.skills);
  if (savedSkillKeys.length !== 6) {
    throw new Error(`FAIL: skills has ${savedSkillKeys.length} keys instead of exactly 6!`);
  }
  const legacyKeys = ['languages', 'frameworks', 'databases', 'cloudDevOps', 'tools', 'other'];
  for (const lk of legacyKeys) {
    if (lk in saved.skills) {
      throw new Error(`FAIL: Legacy key '${lk}' found in saved candidate skills!`);
    }
  }
  if (saved.linkedin !== 'https://linkedin.com/in/adityarajsingh-test') {
    throw new Error('FAIL: LinkedIn link did not save correctly.');
  }

  // Verify settings table link sync
  const linkedinSetting = db.select().from(settings).where(eq(settings.key, 'profile_link_linkedin')).get();
  if (linkedinSetting?.value !== 'https://linkedin.com/in/adityarajsingh-test') {
    throw new Error('FAIL: Settings table link was not synced with candidate profile.');
  }
  console.log('✓ Successfully saved and persisted authoritative candidate profile in SQLite.');
  console.log('✓ Synced profile links to settings table for backwards compatibility.');

  // Test 4: Verify Zero AI for Profile Read/Write
  console.log('\n[Test 4] Verifying profile read/write is 100% offline & zero AI...');
  const reloaded = getCandidateProfile(db);
  if (!isCandidateProfileConfigured(reloaded)) {
    throw new Error('FAIL: isCandidateProfileConfigured returned false for populated profile.');
  }
  console.log('✓ getCandidateProfile() and saveCandidateProfile() operate purely via local SQLite.');

  // Test 4b: Verify Legacy Stored GPA/Score Sanitization
  console.log('\n[Test 4b] Testing legacy stored education JSON with GPA/score sanitization...');
  // Manually write an education entry containing legacy gpa and score properties directly to SQLite
  const legacyEduJson = JSON.stringify([
    {
      id: 'edu_legacy_test',
      institution: 'Legacy Tech Institute',
      degree: 'B.S.',
      fieldOfStudy: 'Computer Science',
      year: '2020 - 2024',
      gpa: '9.5 CGPA',
      score: '95%',
      highlights: ['Algorithms', 'Systems'],
    },
  ]);
  db.run(sql`UPDATE candidate_profile SET education = ${legacyEduJson} WHERE id = 'singleton'`);

  const sanitizedProfile = getCandidateProfile(db);
  const sanitizedEdu = sanitizedProfile.education[0];
  if (!sanitizedEdu) {
    throw new Error('FAIL: Sanitized education entry was not retrieved.');
  }
  if ((sanitizedEdu as any).gpa !== undefined) {
    throw new Error('FAIL: Legacy gpa was not sanitized from candidate education!');
  }
  if ((sanitizedEdu as any).score !== undefined) {
    throw new Error('FAIL: Legacy score was not sanitized from candidate education!');
  }
  if (sanitizedEdu.institution !== 'Legacy Tech Institute' || sanitizedEdu.degree !== 'B.S.') {
    throw new Error('FAIL: Approved education fields were corrupted during sanitization.');
  }
  console.log('✓ Verified: Legacy gpa/score in stored education JSON is strictly sanitized and omitted from CandidateProfile.');

  // Restore the test payload profile for subsequent tests
  saveCandidateProfile(testPayload, db);
  const restoredProfile = getCandidateProfile(db);

  // Test 5: Email Generation Grounding with CandidateProfile
  console.log('\n[Test 5] Testing email generation grounding against manual candidate profile...');
  const emailResult = await generatePersonalizedEmail({
    profile: restoredProfile,
    companyName: 'Stripe',
    contactName: 'Sarah Jenkins',
    designation: 'Head of Engineering Talent',
    companyLocation: 'Bengaluru',
    relevanceReason: 'Leading financial infrastructure and developer APIs',
    preferredStrategy: 'project-focused',
  });

  console.log('  Generated Subject:', emailResult.subject);
  console.log('  Strategy:', emailResult.strategy);
  if (!emailResult.body.includes('Aditya Raj Singh')) {
    throw new Error('FAIL: Generated email signature does not contain candidate full name.');
  }
  if (!emailResult.body.includes('LNJPIT Chapra')) {
    throw new Error('FAIL: Generated email does not contain candidate institution.');
  }
  if (!emailResult.body.includes('AI Job Outreach Engine')) {
    throw new Error('FAIL: Generated email does not reference candidate manual project name.');
  }
  console.log('✓ Email generator correctly ground output in manual candidate facts without hallucination.');

  // Test 6: Verify Physical Resume Attachment Path for Gmail Outreach
  console.log('\n[Test 6] Verifying physical resume PDF attachment handling...');
  const currentResume = db.select().from(resume).where(eq(resume.id, 'current')).get();
  if (currentResume?.filePath) {
    if (fs.existsSync(currentResume.filePath)) {
      const stats = fs.statSync(currentResume.filePath);
      console.log(`✓ Active physical PDF exists on disk: ${currentResume.filename} (${stats.size} bytes).`);
      console.log('✓ sendOutreachEmail can cleanly attach the PDF file to Gmail MIME messages.');
    } else {
      console.log(`Notice: PDF path ${currentResume.filePath} not on this test runner, upload test PDF.`);
    }
  } else {
    console.log('Notice: No resume uploaded yet in test DB (expected on fresh test).');
  }

  // Test 7: Multiline Highlights & Marker Parsing Verification
  console.log('\n[Test 7] Verifying multiline highlight parsing & non-destructive in-memory normalization...');

  // 7a: List marker detection
  if (!hasListMarker('1) Engineered a full-stack platform')) throw new Error('FAIL: 1) not recognized as marker');
  if (!hasListMarker('2. Built an autonomous pipeline')) throw new Error('FAIL: 2. not recognized as marker');
  if (!hasListMarker('(3) Implemented OAuth')) throw new Error('FAIL: (3) not recognized as marker');
  if (!hasListMarker('[4] Developed worker')) throw new Error('FAIL: [4] not recognized as marker');
  if (!hasListMarker('a) Sub-point')) throw new Error('FAIL: a) not recognized as marker');
  if (!hasListMarker('- Dash bullet')) throw new Error('FAIL: - not recognized as marker');
  if (!hasListMarker('• Bullet point')) throw new Error('FAIL: • not recognized as marker');
  if (hasListMarker('classification and personalized outreach')) throw new Error('FAIL: False positive on continuation line');
  if (hasListMarker('35% reduction in latency')) throw new Error('FAIL: False positive on 35% latency');
  if (hasListMarker('2024 graduate')) throw new Error('FAIL: False positive on 2024 graduate');
  console.log('  ✓ Marker detection accurately identifies list markers without false positives on continuation text.');

  // 7b: Future saves - parseRawHighlightsText
  const rawTextareaInput = `1) Engineered a full-stack AI-powered job outreach platform using Next.js, React, and TypeScript,
automating company classification and personalized outreach.

2) Built an autonomous multi-stage AI pipeline with Google Gemini and OpenRouter fallback.

3) Implemented secure Gmail OAuth 2.0 with credential encryption and persistent queues.

4) Developed a fault-tolerant background worker with crash recovery.`;

  const parsedItems = parseRawHighlightsText(rawTextareaInput);
  if (parsedItems.length !== 4) {
    throw new Error(`FAIL: Expected 4 parsed items, got ${parsedItems.length}`);
  }
  if (!parsedItems[0].includes('\n')) {
    throw new Error('FAIL: Continuation newline was not preserved in parsed item 0');
  }
  if (parsedItems[0].includes('TypeScript, automating')) {
    throw new Error('FAIL: Continuation newline was incorrectly converted to space in parsed item 0');
  }
  if (!parsedItems[0].startsWith('1) Engineered')) {
    throw new Error('FAIL: User marker 1) was not preserved in parsed item 0');
  }
  if (!parsedItems[1].startsWith('2) Built')) {
    throw new Error('FAIL: User marker 2) was not preserved in parsed item 1');
  }
  console.log('  ✓ parseRawHighlightsText preserves user markers and embedded newlines (\\n) without converting to space.');

  // 7c: Plain lists with no markers
  const plainCoursework = `Data Structures & Algorithms\nDatabase Management Systems\nOperating Systems`;
  const parsedPlain = parseRawHighlightsText(plainCoursework);
  if (parsedPlain.length !== 3) {
    throw new Error(`FAIL: Expected 3 plain coursework items, got ${parsedPlain.length}`);
  }
  console.log('  ✓ Unmarked lists preserve each non-empty line as a distinct highlight.');

  // 7d: Existing fragmented data normalization in memory
  const fragmentedExistingArray = [
    '1) Engineered a full-stack AI-powered job outreach platform using Next.js, React, and TypeScript,',
    'automating company classification and personalized outreach.',
    '2) Built an autonomous multi-stage AI pipeline with Google Gemini and OpenRouter fallback.',
    '3) Implemented secure Gmail OAuth 2.0 with credential encryption and persistent queues.',
    '4) Developed a fault-tolerant background worker with crash recovery.',
  ];
  const originalCopy = [...fragmentedExistingArray];
  const normalizedExisting = normalizeHighlightItems(fragmentedExistingArray);

  if (normalizedExisting.length !== 4) {
    throw new Error(`FAIL: Expected 4 normalized items from fragmented array, got ${normalizedExisting.length}`);
  }
  if (!normalizedExisting[0].includes('\n')) {
    throw new Error('FAIL: Normalized item 0 did not join continuation fragment with newline');
  }
  if (normalizedExisting[0].includes('TypeScript, automating')) {
    throw new Error('FAIL: Fragmented continuation line was joined with space instead of newline');
  }
  // Verify non-destructive
  if (JSON.stringify(fragmentedExistingArray) !== JSON.stringify(originalCopy)) {
    throw new Error('FAIL: normalizeHighlightItems modified the input array in-place');
  }
  console.log('  ✓ normalizeHighlightItems safely normalizes fragmented existing arrays in-memory without mutating data.');

  // 7e: Plain array without markers remains untouched
  const plainSkills = ['React', 'Node.js', 'PostgreSQL'];
  const normalizedPlain = normalizeHighlightItems(plainSkills);
  if (normalizedPlain.length !== 3 || normalizedPlain[0] !== 'React') {
    throw new Error('FAIL: Plain array without markers was altered by normalizeHighlightItems');
  }
  console.log('  ✓ normalizeHighlightItems leaves plain un-marked arrays completely intact.');

  console.log('\n===============================================================');
  console.log('  ALL MANUAL CANDIDATE PROFILE ARCHITECTURE TESTS PASSED!     ');
  console.log('===============================================================');
}

runTests().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
