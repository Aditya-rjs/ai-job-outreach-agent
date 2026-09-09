/**
 * Comprehensive Verification Test Suite for High-Fidelity Resume Processing,
 * Candidate Profile Structuring, Verified Links Isolation, and Natural Email Personalization.
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';

// Setup isolated test database directory
const TEST_DIR = path.join(
  process.cwd(),
  'data',
  'test-resume-pipeline-' + Date.now()
);
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.OUTREACH_DRY_RUN = 'true';

import { getDb } from '../src/db';
import { initializeDatabase } from '../src/db/migrate';
import { resume, settings, contacts, batches } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { normalizeExtractedPdfText, extractPdfText } from '../src/lib/resume/resume-pdf-extractor';
import { heuristicParseResume, parseAndStructureResume } from '../src/lib/resume/resume-parser';
import { getUserVerifiedLinks, saveUserVerifiedLinks } from '../src/lib/resume/profile-links';
import { generatePersonalizedEmail } from '../src/lib/ai/email-generator';
import type { StructuredResumeProfile, VerifiedProfileLinks } from '../src/types';

const SAMPLE_RESUME_TEXT = `
ADITYA RAJ SINGH
aditya.work2407@gmail.com | +91 9876543210 | Patna, Bihar, India
https://linkedin.com/in/adityarajsingh | https://github.com/adityarajsingh

EDUCATION
LNJPIT Chapra, Bihar
Bachelor of Technology in Computer Science & Engineering
2020 - 2024 | CGPA: 8.24

TECHNICAL SKILLS
Languages: JavaScript, TypeScript, Python, C++, SQL
Frameworks & Libraries: React.js, Next.js, Node.js, Express.js, Tailwind CSS
Databases: PostgreSQL, MongoDB, SQLite, Redis
Cloud & DevOps: Docker, AWS (EC2, S3), Git, GitHub, Linux, Vercel
AI & Machine Learning: Gemini API, OpenAI API, Prompt Engineering, LangChain

PROFESSIONAL EXPERIENCE
Software Development Engineer Intern
Infosys Ltd | Bangalore, India
Jan 2024 - Jun 2024
ï‚· Developed scalable microservices using Node.js, Express, and PostgreSQL handling 50k+ daily transactions.
ï‚· Designed responsive client-facing modules in Next.js reducing page load latency by 35%.
ï‚· Integrated automated CI/CD deployment pipelines using Docker and GitHub Actions.

PROJECTS
Enterprise Outreach Automation Platform
Tech Stack: Next.js 16, TypeScript, Drizzle ORM, SQLite, Gemini AI, Tailwind CSS
ï‚· Architected an autonomous outbound email delivery agent processing hundreds of recruiter contacts.
ï‚· Built multi-layer validation pipeline with AI deduplication, 6-day contact cooldown, and rate limiters.
ï‚· Deployed zero-loss failover architecture achieving 99.9% uptime during peak loads.

AI Clinical Knowledge Assistant
Tech Stack: Python, FastAPI, LangChain, FAISS, Gemini Flash
ï‚· Implemented high-throughput semantic search over medical documentation with sub-50ms query response.
ï‚· Built automated factual grounding guardrails preventing clinical terminology hallucinations.

ACHIEVEMENTS & CERTIFICATIONS
ï‚· Global Rank 142 out of 15,000+ participants in National Coding Challenge 2023.
ï‚· Winner, Smart India Hackathon 2023 Internal Institute Round.
ï‚· AWS Certified Cloud Practitioner (2023).

LEADERSHIP & ACTIVITIES
Lead Coordinator, Open Source & Coding Club (2022 - 2024)
ï‚· Mentored 150+ junior students in full-stack web development and algorithms.
`;

async function runTests() {
  console.log('=== VERIFYING HIGH-FIDELITY RESUME & CANDIDATE PROFILE PIPELINE ===\n');

  // Initialize DB
  initializeDatabase();
  const db = getDb();

  // --------------------------------------------------------------------------
  // TEST 1: Text Normalization & Glyph Sanitization
  // --------------------------------------------------------------------------
  console.log('Test 1: PDF Text Normalization and Mojibake Sanitization...');
  const normalized = normalizeExtractedPdfText(SAMPLE_RESUME_TEXT);
  assert(!normalized.includes('ï‚·'), 'Mojibake bullet points (ï‚·) must be replaced with clean bullet symbols');
  assert(normalized.includes('• Developed scalable microservices'), 'Sanitized text should contain standard bullet points');
  assert(normalized.includes('ADITYA RAJ SINGH'), 'Candidate name preserved');
  console.log('✓ Text normalization and glyph sanitization passed.\n');

  // --------------------------------------------------------------------------
  // TEST 2: High-Fidelity Heuristic Parser & Structured Candidate Profile
  // --------------------------------------------------------------------------
  console.log('Test 2: High-Fidelity Resume Parser (Non-destructive Fallback)...');
  const parsedProfile = heuristicParseResume(normalized);

  assert.strictEqual(parsedProfile.name, 'ADITYA RAJ SINGH', 'Name should be correctly extracted');
  assert.strictEqual(parsedProfile.email, 'aditya.work2407@gmail.com', 'Email should be extracted');
  assert(parsedProfile.phone?.includes('9876543210'), 'Phone should be extracted');

  // Education verification
  assert(parsedProfile.education.length > 0, 'Education array must not be empty');
  assert(
    parsedProfile.education[0].institution.toLowerCase().includes('lnjpit') ||
    parsedProfile.education[0].degree.toLowerCase().includes('computer science'),
    'Education details must contain institution or degree'
  );

  // Categorized skills verification
  assert(parsedProfile.skills.languages.length >= 3, 'Languages must be categorized');
  assert(parsedProfile.skills.languages.some(l => l.toLowerCase().includes('typescript')), 'TypeScript should be in languages');
  assert(parsedProfile.skills.frameworks.length >= 2, 'Frameworks must be categorized');
  assert(parsedProfile.skills.databases.length >= 2, 'Databases must be categorized');

  // Experience verification (Non-destructive check: MUST NOT BE EMPTY)
  assert(parsedProfile.experience && parsedProfile.experience.length > 0, 'Experience array must NOT be empty');
  assert.strictEqual(parsedProfile.experience[0]?.company, 'Infosys Ltd', 'Experience company should be Infosys Ltd');
  assert((parsedProfile.experience[0]?.bullets?.length ?? 0) >= 2, 'Experience bullets should be extracted');

  // Projects verification (Non-destructive check: MUST NOT BE EMPTY)
  assert(parsedProfile.projects && parsedProfile.projects.length >= 2, 'Projects array must contain at least 2 projects');
  assert(parsedProfile.projects[0].title.includes('Enterprise Outreach'), 'Project 1 title must match');
  assert(parsedProfile.projects[0].techStack.length >= 2, 'Project tech stack must be populated');

  // Achievements & Leadership verification
  assert(parsedProfile.achievements && parsedProfile.achievements.length >= 1, 'Achievements must be populated');
  console.log('✓ High-fidelity parser extracted education, skills, experience, projects, achievements, and leadership cleanly.\n');

  // --------------------------------------------------------------------------
  // TEST 3: Verified Links Isolation & Independent Persistence
  // --------------------------------------------------------------------------
  console.log('Test 3: Verified Profile Links Isolation & Persistence in Settings...');
  // Check default
  const defaultLinks = getUserVerifiedLinks();
  assert(!defaultLinks.linkedin, 'Default linkedin link should be null or empty');

  // Save verified links
  const userLinks: VerifiedProfileLinks = {
    linkedin: 'https://www.linkedin.com/in/adityarajsingh-verified',
    github: 'https://github.com/adityarajsingh-verified',
    portfolio: 'https://adityarajsingh.dev',
    other: 'https://leetcode.com/adityarajsingh',
  };
  saveUserVerifiedLinks(userLinks, db);

  const savedLinks = getUserVerifiedLinks(db);
  assert.strictEqual(savedLinks.linkedin, userLinks.linkedin, 'Saved linkedin link matches');
  assert.strictEqual(savedLinks.github, userLinks.github, 'Saved github link matches');
  assert.strictEqual(savedLinks.portfolio, userLinks.portfolio, 'Saved portfolio link matches');
  assert.strictEqual(savedLinks.other, userLinks.other, 'Saved other link matches');

  // Invariant check: StructuredResumeProfile does NOT contain verifiedLinks
  assert(!('verifiedLinks' in parsedProfile), 'StructuredResumeProfile MUST NOT store verifiedLinks internally');
  console.log('✓ Verified links persist independently and remain isolated from resume profile.\n');

  // --------------------------------------------------------------------------
  // TEST 4: Email Generation with Rich Profile Facts & Natural Fresher Framing
  // --------------------------------------------------------------------------
  console.log('Test 4: Email Generation with Rich Facts & Natural Fresher Inquiry...');

  // Test across multiple strategies to verify natural opportunity inquiry wording
  const testStrategies = ['skills-focused', 'project-focused', 'company-focused', 'concise-direct', 'technical'];

  for (const strategy of testStrategies) {
    const emailResult = await generatePersonalizedEmail({
      profile: parsedProfile,
      companyName: 'Acme Technologies Inc.',
      contactName: 'Priya Sharma',
      designation: 'Technical Talent Acquisition Lead',
      relevanceReason: 'Acme builds enterprise cloud solutions and distributes scalable web systems',
      preferredStrategy: strategy,
      verifiedLinks: savedLinks,
    });

    // Verify subject line contains general opportunity inquiry phrasing
    assert(
      emailResult.subject.toLowerCase().includes('exploring') ||
      emailResult.subject.toLowerCase().includes('opportunity') ||
      emailResult.subject.toLowerCase().includes('inquiry') ||
      emailResult.subject.toLowerCase().includes('fresher') ||
      emailResult.subject.toLowerCase().includes('entry-level'),
      'Subject line must be a natural opportunity inquiry: ' + emailResult.subject
    );

    // Verify subject line mentions candidate name and company
    assert(emailResult.subject.includes('Acme Technologies Inc.'), 'Subject must mention company');
    assert(emailResult.subject.includes(parsedProfile.name), 'Subject must mention candidate name');

    // Verify body contains recruiter greeting
    assert(emailResult.body.includes('Dear Priya Sharma,'), 'Greeting must address recruiter');

    // Verify candidate factual grounding (e.g. LNJPIT, Enterprise Outreach, or TypeScript/React)
    const bodyLower = emailResult.body.toLowerCase();
    const mentionsFacts =
      bodyLower.includes('lnjpit') ||
      bodyLower.includes('enterprise outreach') ||
      bodyLower.includes('engineering') ||
      bodyLower.includes('software');
    assert(mentionsFacts, 'Body must reflect candidate facts');

    // Verify natural fresher/entry-level inquiry framing (NO rigid role pigeonholing)
    assert(
      bodyLower.includes('fresher') ||
      bodyLower.includes('entry-level') ||
      bodyLower.includes('opening') ||
      bodyLower.includes('opportunities'),
      'Body must explore fresher/entry-level opportunities'
    );

    // Verify signature includes verified links
    assert(emailResult.body.includes(savedLinks.linkedin || ''), 'Signature must include verified LinkedIn');
    assert(emailResult.body.includes(savedLinks.github || ''), 'Signature must include verified GitHub');
    assert(emailResult.body.includes(savedLinks.portfolio || ''), 'Signature must include verified Portfolio');
  }
  console.log('✓ Email generator generates naturally diverse, factually grounded fresher opportunity inquiries.\n');

  // --------------------------------------------------------------------------
  // TEST 5: Resume Re-upload Does Not Overwrite User-Verified Links
  // --------------------------------------------------------------------------
  console.log('Test 5: Resume replacement maintains verified links...');
  // Simulate resume replacement in DB
  const newResumeRecord = {
    id: 'current',
    filename: 'Aditya_New_Resume_2026.pdf',
    filePath: '/tmp/new_resume.pdf',
    mimeType: 'application/pdf',
    parsedText: normalized,
    parsedData: JSON.stringify(parsedProfile),
    uploadedAt: new Date().toISOString(),
  };

  db.insert(resume)
    .values(newResumeRecord)
    .onConflictDoUpdate({
      target: resume.id,
      set: newResumeRecord,
    })
    .run();

  // Verify verified links remain intact
  const linksAfterResumeReupload = getUserVerifiedLinks(db);
  assert.strictEqual(
    linksAfterResumeReupload.linkedin,
    userLinks.linkedin,
    'Verified links MUST persist across resume PDF re-uploads'
  );
  assert.strictEqual(
    linksAfterResumeReupload.github,
    userLinks.github,
    'GitHub link MUST persist across resume PDF re-uploads'
  );
  console.log('✓ Resume re-upload verified: user-verified links preserved intact.\n');

  // --------------------------------------------------------------------------
  // TEST 6: Real-World Bullet-Prefixed Resume Formatting & Compound Headings
  // --------------------------------------------------------------------------
  console.log('Test 6: Real-World Bullet-Prefixed Resume Formatting & Compound Headings...');
  const REAL_WORLD_RESUME_TEXT = `
ADITYA RAJ SINGH
aditya.work2407@gmail.com | +91 9876543210
Patna, Bihar, India

EDUCATION
- LNJPIT Chapra
- Bachelor of Technology in Computer Science & Engineering
- 2020 - 2024 | CGPA: 8.24

TECHNICAL SKILLS
- Languages: JavaScript, TypeScript, Python, SQL
- Frontend: React.js, Next.js, HTML5, CSS3, Tailwind CSS
- Backend: Node.js, Express.js, REST APIs
- Databases: PostgreSQL, MongoDB, SQLite
- Cloud / DevOps: Docker, AWS, Git, GitHub
- Tools: VS Code, Postman, Linux

EXPERIENCE
- Invigo Infotech
- Web Development Intern
- Dec 2025 – Jan 2026
- Developed high-performance responsive web dashboard using React and Tailwind CSS.
- Optimized REST API endpoints reducing query latency by 30%.
- Collaborated with senior engineers on client feature deliverables.

PROJECTS
- AI Job Outreach Agent
- Next.js 16, TypeScript, Drizzle ORM, SQLite
- Jan 2026 – Feb 2026
- Engineered end-to-end recruiter outreach system with AI email generation and rate limits.
- Built multi-phase deduplication and domain cooldown mechanics.

ACHIEVEMENTS & CERTIFICATIONS
- 1st Place at National Level Hackathon 2024
- AWS Certified Cloud Practitioner
- Solved 400+ problems on LeetCode

LEADERSHIP
- Technical Lead, College Coding Society
- Conducted hands-on web development workshops for 100+ students.
`;

  const normalizedRealWorld = normalizeExtractedPdfText(REAL_WORLD_RESUME_TEXT);
  const parsedRealWorld = heuristicParseResume(normalizedRealWorld);

  // Verify Experience extraction from bulleted format
  assert(parsedRealWorld.experience && parsedRealWorld.experience.length > 0, 'Real-world experience array must NOT be 0');
  const expItem = parsedRealWorld.experience[0];
  assert.strictEqual(expItem.company, 'Invigo Infotech', 'Company must be Invigo Infotech');
  assert.strictEqual(expItem.role, 'Web Development Intern', 'Role must be Web Development Intern');
  assert(expItem.duration?.includes('Dec 2025'), 'Duration must be Dec 2025 – Jan 2026');
  assert((expItem.bullets?.length ?? 0) >= 2, 'Experience bullets must be captured');

  // Verify Projects extraction from bulleted format
  assert(parsedRealWorld.projects && parsedRealWorld.projects.length > 0, 'Real-world projects array must NOT be 0');
  const projItem = parsedRealWorld.projects[0];
  assert.strictEqual(projItem.title, 'AI Job Outreach Agent', 'Project title must be AI Job Outreach Agent');
  assert((projItem.bullets?.length ?? 0) >= 1, 'Project bullets must be captured');

  // Verify compound header extraction
  assert(parsedRealWorld.achievements && parsedRealWorld.achievements.length > 0, 'Achievements must NOT be 0');
  assert(parsedRealWorld.certifications && parsedRealWorld.certifications.length > 0, 'Certifications must NOT be 0');
  assert(parsedRealWorld.leadership && parsedRealWorld.leadership.length > 0, 'Leadership must NOT be 0');

  console.log('✓ Real-world bullet-prefixed resume parsing passed (Experience, Projects, Certifications, Achievements populated).\n');

  // --------------------------------------------------------------------------
  // TEST 7: DB Re-analysis of Existing Stored parsedText (Upgrade Legacy Record)
  // --------------------------------------------------------------------------
  console.log('Test 7: DB Re-analysis of Existing Stored parsedText...');
  // Simulate legacy DB state: parsedText exists, but parsedData has 0 experience/projects
  const legacyParsedData: StructuredResumeProfile = {
    name: 'Aditya Raj Singh',
    email: 'aditya.work2407@gmail.com',
    phone: null,
    location: null,
    education: [{ institution: 'LNJPIT Chapra', degree: 'B.Tech CSE', year: '2024' }],
    skills: {
      languages: ['TypeScript', 'JavaScript'],
      frontend: ['React'],
      backend: ['Node.js'],
      frameworks: [],
      databases: [],
      aiMl: [],
      dataScience: [],
      cloudDevOps: [],
      tools: ['Git'],
      apisIntegrations: [],
      coreCs: [],
      other: [],
    },
    experience: [], // 0 in legacy
    projects: [],   // 0 in legacy
    certifications: [],
    achievements: [],
    leadership: [],
    summary: 'Legacy summary',
  };

  db.insert(resume)
    .values({
      id: 'current',
      filename: 'Aditya_Resume.pdf',
      filePath: '/data/resumes/Aditya_Resume.pdf',
      mimeType: 'application/pdf',
      parsedText: normalizedRealWorld,
      parsedData: JSON.stringify(legacyParsedData),
      uploadedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: resume.id,
      set: {
        parsedText: normalizedRealWorld,
        parsedData: JSON.stringify(legacyParsedData),
      },
    })
    .run();

  // Verify DB starts in legacy 0-count state
  const legacyRecord = db.select().from(resume).where(eq(resume.id, 'current')).get();
  assert(legacyRecord, 'Legacy record must exist');
  const initialData: StructuredResumeProfile = JSON.parse(legacyRecord.parsedData || '{}');
  assert.strictEqual(initialData.experience.length, 0, 'Legacy experience count should initially be 0');
  assert.strictEqual(initialData.projects.length, 0, 'Legacy projects count should initially be 0');

  // Perform re-analysis using heuristic fallback (or AI when configured)
  const upgradedProfile = heuristicParseResume(legacyRecord.parsedText || '');
  db.update(resume)
    .set({
      parsedData: JSON.stringify(upgradedProfile),
    })
    .where(eq(resume.id, 'current'))
    .run();

  // Verify DB record is now upgraded
  const upgradedRecord = db.select().from(resume).where(eq(resume.id, 'current')).get();
  const verifiedData: StructuredResumeProfile = JSON.parse(upgradedRecord?.parsedData || '{}');
  assert(verifiedData.experience.length > 0, 'Upgraded DB record must have experience > 0');
  assert.strictEqual(verifiedData.experience[0].company, 'Invigo Infotech', 'Upgraded company must match');
  assert(verifiedData.projects.length > 0, 'Upgraded DB record must have projects > 0');
  assert(verifiedData.certifications.length > 0, 'Upgraded DB record must have certifications > 0');
  console.log('✓ Database re-analysis cleanly upgraded legacy 0-count record to fully populated state.\n');

  // --------------------------------------------------------------------------
  // TEST 8: Canonical Skill Keys Hygiene
  // --------------------------------------------------------------------------
  console.log('Test 8: Canonical Skill Keys Hygiene...');
  const skillKeys = Object.keys(upgradedProfile.skills);
  const canonicalKeys = [
    'languages',
    'frontend',
    'backend',
    'frameworks',
    'databases',
    'aiMl',
    'dataScience',
    'cloudDevOps',
    'tools',
    'apisIntegrations',
    'coreCs',
    'other',
  ];
  for (const k of skillKeys) {
    assert(canonicalKeys.includes(k), `Key '${k}' must be one of the canonical ResumeSkills schema keys`);
  }
  assert(!('developerTools' in upgradedProfile.skills), 'Legacy alias developerTools must NOT be written to output object');
  console.log('✓ Canonical skill keys schema verified (no duplicate/legacy keys written).\n');

  // Clean up test directory
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}

  console.log('================================================================');
  console.log('ALL HIGH-FIDELITY RESUME PIPELINE TESTS PASSED SUCCESSFULLY (8/8)');
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});

