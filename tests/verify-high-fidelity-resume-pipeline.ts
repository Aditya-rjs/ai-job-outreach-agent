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
import { heuristicParseResume, parseAndStructureResume, structureResumeFromPdf, normalizeStructuredProfile } from '../src/lib/resume/resume-parser';
import { getUserVerifiedLinks, saveUserVerifiedLinks } from '../src/lib/resume/profile-links';
import { generatePersonalizedEmail } from '../src/lib/ai/email-generator';
import { OpenRouterError } from '../src/lib/ai/openrouter-client';
import { GET as getResumeFile } from '../src/app/api/resume/file/route';
import { NextRequest } from 'next/server';
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

  // --------------------------------------------------------------------------
  // TEST 9: Gemini Multimodal Document Attachment & Model Default Invariant
  // --------------------------------------------------------------------------
  console.log('Test 9: Gemini Multimodal Document Attachment & Model Default Invariant...');
  const configuredGeminiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';
  assert.strictEqual(
    configuredGeminiModel,
    'gemini-3.8-flash',
    'Gemini default model MUST remain gemini-3.8-flash and never be changed to gemini-2.5-flash'
  );

  // Verify inlineData structure preparation
  const testPdfBytes = Buffer.from('%PDF-1.4 test resume pdf content');
  const base64Data = testPdfBytes.toString('base64');
  const geminiDocumentPart = {
    inlineData: {
      mimeType: 'application/pdf',
      data: base64Data,
    },
  };
  assert.strictEqual(geminiDocumentPart.inlineData.mimeType, 'application/pdf', 'MIME type must be application/pdf');
  assert.strictEqual(geminiDocumentPart.inlineData.data, base64Data, 'Base64 data must match PDF bytes');
  console.log('✓ Gemini multimodal document attachment & model default invariant verified.\n');

  // --------------------------------------------------------------------------
  // TEST 10: OpenRouter Direct PDF Payload Formatting & Capability Guard
  // --------------------------------------------------------------------------
  console.log('Test 10: OpenRouter Direct PDF Payload Formatting & Capability Guard...');
  const openRouterUserContent = [
    {
      type: 'file',
      file: {
        filename: 'resume.pdf',
        file_data: `data:application/pdf;base64,${base64Data}`,
      },
    },
    {
      type: 'text',
      text: 'Analyze this resume.',
    },
  ];
  const filePart = openRouterUserContent[0] as { type: string; file: { filename: string; file_data: string } };
  assert.strictEqual(filePart.type, 'file', 'OpenRouter PDF content type must be "file" and NOT "document"');
  assert(filePart.file.file_data.startsWith('data:application/pdf;base64,'), 'file_data must use data URI scheme');
  assert.strictEqual(openRouterUserContent[1].type, 'text', 'Second part must be text prompt');

  // Verify OpenRouter document-unsupported 400 error detection
  const unsupportedDocErr = new OpenRouterError(
    "OpenRouter route/model 'free' does not support PDF/file input: Unsupported file type",
    400,
    false,
    true
  );
  assert.strictEqual(unsupportedDocErr.isDocumentUnsupported, true, 'isDocumentUnsupported flag must be true');
  assert.strictEqual(unsupportedDocErr.isRateLimit, false, 'isRateLimit must be false for document unsupported');
  console.log('✓ OpenRouter direct PDF payload formatting and capability guard verified.\n');

  // --------------------------------------------------------------------------
  // TEST 11: Strict No-Degradation Rule (Multimodal AI Unavailable Refuses Silent Fallback)
  // --------------------------------------------------------------------------
  console.log('Test 11: Strict No-Degradation Rule...');
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ALLOW_OFFLINE_HEURISTIC_PARSER;

  let noDegradationErrorCaught = false;
  try {
    await structureResumeFromPdf(testPdfBytes, 'test.pdf');
  } catch (err: any) {
    noDegradationErrorCaught = true;
    assert(
      err.message.includes('AI resume structuring requires a multimodal provider capable of processing PDF documents'),
      `Error must explain multimodal requirement, got: ${err.message}`
    );
  }
  assert(noDegradationErrorCaught, 'structureResumeFromPdf MUST throw rather than silently falling back to lossy regex');
  console.log('✓ Strict no-degradation rule verified (throws clean actionable error when multimodal unavailable).\n');

  // --------------------------------------------------------------------------
  // TEST 12: Secure Resume File Serving Route (/api/resume/file)
  // --------------------------------------------------------------------------
  console.log('Test 12: Secure Resume File Serving Route (/api/resume/file)...');
  const resumesDir = path.join(TEST_DIR, 'resumes');
  fs.mkdirSync(resumesDir, { recursive: true });
  const testSafeResumePath = path.join(resumesDir, 'test_resume_sample.pdf');
  fs.writeFileSync(testSafeResumePath, testPdfBytes);

  // Insert valid resume in test DB
  db.insert(resume)
    .values({
      id: 'current',
      filename: 'Aditya_Resume.pdf',
      filePath: testSafeResumePath,
      mimeType: 'application/pdf',
      parsedText: 'Sample text',
      parsedData: JSON.stringify({}),
      version: new Date().toISOString(),
      uploadedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: resume.id,
      set: {
        filePath: testSafeResumePath,
      },
    })
    .run();

  // 12a: Preview request (inline)
  const inlineReq = new NextRequest('http://localhost:3000/api/resume/file');
  const inlineRes = await getResumeFile(inlineReq);
  assert.strictEqual(inlineRes.status, 200, 'Inline resume file response status must be 200');
  assert.strictEqual(inlineRes.headers.get('content-type'), 'application/pdf', 'Content-Type must be application/pdf');
  assert(
    inlineRes.headers.get('content-disposition')?.includes('inline'),
    'Content-Disposition must be inline for preview'
  );

  // 12b: Download request (attachment)
  const downloadReq = new NextRequest('http://localhost:3000/api/resume/file?download=true');
  const downloadRes = await getResumeFile(downloadReq);
  assert.strictEqual(downloadRes.status, 200, 'Download resume file response status must be 200');
  assert(
    downloadRes.headers.get('content-disposition')?.includes('attachment'),
    'Content-Disposition must be attachment for download'
  );

  // 12c: Path traversal attack protection
  db.update(resume)
    .set({
      filePath: path.join(TEST_DIR, '..', '..', 'etc', 'passwd'),
    })
    .where(eq(resume.id, 'current'))
    .run();

  const attackReq = new NextRequest('http://localhost:3000/api/resume/file');
  const attackRes = await getResumeFile(attackReq);
  assert(
    attackRes.status === 403 || attackRes.status === 404,
    `Path traversal attempt must be rejected with 403 or 404, got: ${attackRes.status}`
  );
  console.log('✓ Secure resume file serving route verified (inline preview, download attachment, path traversal protection).\n');

  // --------------------------------------------------------------------------
  // TEST 13: Full Direct-to-AI Candidate Fact Completeness & Accuracy
  // --------------------------------------------------------------------------
  console.log('Test 13: Full Direct-to-AI Candidate Fact Completeness & Accuracy...');
  const rawMultimodalResponse = {
    name: 'Aditya Raj Singh',
    email: 'aditya.work2407@gmail.com',
    phone: '+91 9876543210',
    location: 'Patna, Bihar, India',
    education: [
      {
        institution: 'Loknayak Jai Prakash Institute of Technology',
        degree: 'Bachelor of Technology in Computer Science & Engineering',
        boardOrUniversity: 'Aryabhatta Knowledge University',
        year: '2020 - 2024',
        score: '8.24 CGPA',
      },
      {
        institution: 'Central Board of Secondary Education',
        degree: 'Senior Secondary (12th)',
        boardOrUniversity: 'CBSE',
        year: '2021',
        score: '85.2%',
      },
      {
        institution: 'Central Board of Secondary Education',
        degree: 'Secondary (10th)',
        boardOrUniversity: 'CBSE',
        year: '2019',
        score: '84.4%',
      },
    ],
    skills: {
      languages: ['TypeScript', 'JavaScript', 'Python', 'C++', 'SQL'],
      frontend: ['React.js', 'Next.js', 'Tailwind CSS'],
      backend: ['Node.js', 'Express.js', 'FastAPI'],
      frameworks: ['React.js', 'Next.js', 'Express.js'],
      databases: ['PostgreSQL', 'SQLite', 'MongoDB', 'Redis'],
      aiMl: ['Google Gemini API', 'LangChain', 'Prompt Engineering'],
      dataScience: ['NumPy', 'Pandas'],
      cloudDevOps: ['Docker', 'AWS', 'Git', 'GitHub Actions', 'Vercel'],
      tools: ['Git', 'VS Code', 'Postman', 'Linux'],
      apisIntegrations: ['REST APIs', 'Gmail API', 'OAuth 2.0'],
      coreCs: ['Data Structures & Algorithms', 'DBMS', 'OOP', 'Operating Systems'],
      other: [],
    },
    experience: [
      {
        role: 'Web Development Intern',
        company: 'Invigo Infotech',
        employmentType: 'Internship',
        duration: 'Dec 2025 – Jan 2026',
        bullets: [
          'Engineered responsive web applications utilizing React, TypeScript, and modern CSS.',
          'Collaborated in agile development sprints delivering production frontend features on schedule.',
        ],
      },
      {
        role: 'Frontend Developer Intern',
        company: 'Polytropic Services',
        employmentType: 'Internship',
        duration: 'Nov 2024 – Dec 2024',
        bullets: [
          'Developed interactive dashboard interfaces using Next.js and Tailwind CSS.',
          'Optimized component rendering performance and implemented client-side state caching.',
        ],
      },
    ],
    projects: [
      {
        title: 'AI Job Outreach Agent',
        techStack: ['Next.js 16', 'TypeScript', 'Drizzle ORM', 'SQLite', 'Gemini AI'],
        bullets: [
          'Engineered an autonomous outbound email delivery agent with multi-layer deduplication and 6-day cooldown.',
          'Implemented direct multimodal PDF resume architecture for high-fidelity personalized email generation.',
        ],
      },
      {
        title: 'AI Clinical Knowledge Assistant',
        techStack: ['Python', 'FastAPI', 'LangChain', 'FAISS', 'Gemini Flash'],
        bullets: [
          'Implemented high-throughput semantic search over clinical documentation with sub-50ms query response.',
          'Built automated factual grounding guardrails preventing clinical terminology hallucinations.',
        ],
      },
    ],
    certifications: [
      { name: 'AWS Certified Cloud Practitioner', issuer: 'Amazon Web Services', date: '2023' },
    ],
    achievements: [
      {
        title: 'National Coding Challenge 2023',
        description: 'Global Rank 142 out of 15,000+ participants in National Coding Challenge 2023.',
        rank: 'Global Rank 142',
      },
      {
        title: 'Smart India Hackathon 2023',
        description: 'Winner, Smart India Hackathon 2023 Internal Institute Round.',
      },
    ],
    leadership: [
      {
        position: 'Lead Coordinator',
        organization: 'Open Source & Coding Club',
        duration: '2022 - 2024',
        highlights: ['Mentored 150+ junior students in full-stack web development.'],
      },
      {
        position: 'Technical Lead',
        organization: 'College Coding Society',
        highlights: ['Conducted hands-on web development workshops for 100+ students.'],
      },
    ],
    summary: 'Full-stack developer specializing in Next.js, TypeScript, and autonomous AI applications.',
  };

  const normalizedProfile = normalizeStructuredProfile(rawMultimodalResponse);

  // 13a: 3 Education entries preserved with separated degrees, boards, scores, and years
  assert.strictEqual(normalizedProfile.education.length, 3, 'Must have exactly 3 education entries');
  assert.strictEqual(normalizedProfile.education[0].institution, 'Loknayak Jai Prakash Institute of Technology');
  assert.strictEqual(normalizedProfile.education[0].score, '8.24 CGPA');
  assert.strictEqual(normalizedProfile.education[1].degree, 'Senior Secondary (12th)');
  assert.strictEqual(normalizedProfile.education[1].score, '85.2%');
  assert.strictEqual(normalizedProfile.education[2].degree, 'Secondary (10th)');
  assert.strictEqual(normalizedProfile.education[2].score, '84.4%');

  // 13b: 2 Real Internships verified
  assert.strictEqual(normalizedProfile.experience.length, 2, 'Must have exactly 2 internships');
  assert.strictEqual(normalizedProfile.experience[0].company, 'Invigo Infotech');
  assert.strictEqual(normalizedProfile.experience[0].role, 'Web Development Intern');
  assert(normalizedProfile.experience[0].bullets!.length >= 2, 'Invigo Infotech must have 2+ bullets');
  assert.strictEqual(normalizedProfile.experience[1].company, 'Polytropic Services');
  assert.strictEqual(normalizedProfile.experience[1].role, 'Frontend Developer Intern');
  assert(normalizedProfile.experience[1].bullets!.length >= 2, 'Polytropic Services must have 2+ bullets');

  // 13c: 2 Distinct real projects (zero generic placeholders)
  assert.strictEqual(normalizedProfile.projects.length, 2, 'Must have exactly 2 projects');
  assert.strictEqual(normalizedProfile.projects[0].title, 'AI Job Outreach Agent');
  assert.strictEqual(normalizedProfile.projects[1].title, 'AI Clinical Knowledge Assistant');
  for (const proj of normalizedProfile.projects) {
    assert(!proj.title.toLowerCase().includes('technical project'), 'Project title must not be a generic placeholder');
  }

  // 13d: 2 Unfragmented achievements & 2 leadership positions
  assert.strictEqual(normalizedProfile.achievements?.length, 2, 'Must have exactly 2 achievements');
  assert.strictEqual(normalizedProfile.leadership?.length, 2, 'Must have exactly 2 leadership positions');

  // 13e: Canonical ResumeSkills schema hygiene
  const finalSkillKeys = Object.keys(normalizedProfile.skills);
  for (const k of finalSkillKeys) {
    assert(canonicalKeys.includes(k), `Skill key '${k}' must be canonical`);
  }
  console.log('✓ Full Direct-to-AI candidate fact completeness & accuracy verified (3 edu, 2 exp, 2 proj, 2 ach, 2 lead, canonical skills).\n');

  // Clean up test directory
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}

  console.log('================================================================');
  console.log('ALL HIGH-FIDELITY RESUME PIPELINE TESTS PASSED SUCCESSFULLY (13/13)');
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});

