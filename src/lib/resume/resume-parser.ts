import { extractPdfText } from './resume-pdf-extractor';
import { callAi } from '@/lib/ai/ai-dispatcher';
import { getGeminiClient, GEMINI_PRIORITIES } from '@/lib/ai/gemini-client';
import { isOpenRouterConfigured } from '@/lib/ai/openrouter-client';
import type {
  StructuredResumeProfile,
  ResumeEducation,
  ResumeSkills,
  ResumeExperience,
  ResumeProject,
  ResumeCertification,
  ResumeAchievement,
  ResumeLeadership,
} from '@/types';

/**
 * Intelligent section-aware heuristic fallback parser when AI providers are unreachable.
 * Unlike the previous lossy implementation, this parser slices sections by headings
 * and preserves candidate experiences, projects, skills, education, and achievements.
 */
export function heuristicParseResume(text: string): StructuredResumeProfile {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // 1. Name: usually first line or lines
  let name = 'Applicant';
  if (lines.length > 0) {
    const candidate = lines[0].replace(/[^a-zA-Z\s]/g, '').trim();
    if (candidate.length >= 2 && candidate.length <= 40 && candidate.split(/\s+/).length <= 4) {
      name = candidate;
    }
  }

  // 2. Email
  const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const email = emailMatch ? emailMatch[0].toLowerCase() : null;

  // 3. Phone
  const phoneMatch = text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  const phone = phoneMatch ? phoneMatch[0] : null;

  // 4. Skills extraction via categorized keywords
  const skillKeywords: Record<string, string[]> = {
    languages: ['JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'C', 'Go', 'Rust', 'Ruby', 'PHP', 'SQL', 'HTML', 'CSS'],
    frameworks: ['React', 'Next.js', 'Node.js', 'Express', 'Vue', 'Angular', 'Django', 'Flask', 'Spring Boot', 'Tailwind', 'Bootstrap', 'Redux'],
    databases: ['PostgreSQL', 'MySQL', 'MongoDB', 'SQLite', 'Redis', 'Firebase', 'Supabase', 'Drizzle ORM'],
    cloudDevOps: ['AWS', 'GCP', 'Azure', 'Docker', 'Kubernetes', 'CI/CD', 'Git', 'GitHub Actions', 'Vercel'],
    tools: ['Git', 'GitHub', 'VS Code', 'Postman', 'Figma', 'Linux', 'Jira', 'npm'],
    aiMl: ['Machine Learning', 'Deep Learning', 'Google Gemini', 'OpenRouter', 'Scikit-learn', 'XGBoost', 'Random Forest', 'SHAP', 'Pandas', 'NumPy', 'TensorFlow', 'PyTorch'],
    coreCs: ['Data Structures', 'Algorithms', 'OOP', 'Object-Oriented Programming', 'DBMS', 'Operating Systems', 'Computer Networks'],
    apisIntegrations: ['REST APIs', 'GraphQL', 'Gmail API', 'OAuth 2.0', 'Webhooks'],
  };

  const foundSkills: ResumeSkills = {
    languages: [],
    frameworks: [],
    databases: [],
    cloudDevOps: [],
    tools: [],
    frontend: [],
    backend: [],
    aiMl: [],
    dataScience: [],
    apisIntegrations: [],
    coreCs: [],
    other: [],
  };

  for (const [cat, kws] of Object.entries(skillKeywords)) {
    for (const kw of kws) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(?:^|\\s|[\\(,\\/])${escaped}(?:$|\\s|[\\),\\/.])`, 'i');
      if (regex.test(text)) {
        const target = foundSkills[cat as keyof ResumeSkills] as string[] | undefined;
        if (target && !target.includes(kw)) {
          target.push(kw);
        }
      }
    }
  }

  // 5. Section Boundary Slicing for Experience, Projects, Achievements, Education
  const sections: Record<string, string[]> = {};
  let currentSection = 'HEADER';
  sections[currentSection] = [];

  const SECTION_HEADERS: Array<{ key: string; regex: RegExp }> = [
    { key: 'EDUCATION', regex: /^(?:EDUCATION|ACADEMICS|ACADEMIC BACKGROUND)\b/i },
    { key: 'EXPERIENCE', regex: /^(?:EXPERIENCE|WORK EXPERIENCE|PROFESSIONAL EXPERIENCE|INTERNSHIPS)\b/i },
    { key: 'PROJECTS', regex: /^(?:PROJECTS|TECHNICAL PROJECTS|KEY PROJECTS|ACADEMIC PROJECTS)\b/i },
    { key: 'SKILLS', regex: /^(?:TECHNICAL SKILLS|SKILLS|SKILLS & TECHNOLOGIES|CORE COMPETENCIES)\b/i },
    { key: 'ACHIEVEMENTS', regex: /^(?:ACHIEVEMENTS|HONORS|AWARDS|ACCOMPLISHMENTS)\b/i },
    { key: 'LEADERSHIP', regex: /^(?:POSITIONS OF RESPONSIBILITY|LEADERSHIP|EXTRACURRICULAR)\b/i },
    { key: 'CERTIFICATIONS', regex: /^(?:CERTIFICATIONS|LICENSES & CERTIFICATIONS)\b/i },
  ];

  for (const line of lines) {
    const matchedHeader = SECTION_HEADERS.find((h) => h.regex.test(line));
    if (matchedHeader) {
      currentSection = matchedHeader.key;
      if (!sections[currentSection]) sections[currentSection] = [];
    } else {
      sections[currentSection].push(line);
    }
  }

  // 6. Parse Education
  const education: ResumeEducation[] = [];
  const eduLines = sections['EDUCATION'] || [];
  if (eduLines.length > 0) {
    let currentDegree = '';
    let currentInst = '';
    let currentYear: string | undefined = undefined;

    for (const line of eduLines) {
      if (/Institute\/Board|CGPA\/Percentage|Year/i.test(line) && line.length < 50) {
        continue; // Skip table header artifact
      }
      const yearMatch = line.match(/\b(19|20)\d{2}(?:\s*[-–]\s*(?:(19|20)\d{2}|Present))?\b/i);
      const degreeMatch = line.match(/(?:Bachelor|B\.?Tech|Master|M\.?Tech|B\.?S|M\.?S|Secondary|Senior Secondary)[^,\n]*/i);
      const instMatch = line.match(/(?:LNJPIT|University|Institute|College|School|Central Board)[^,\n]*/i);

      if (degreeMatch || instMatch) {
        education.push({
          degree: degreeMatch ? degreeMatch[0].trim() : (currentDegree || 'Degree'),
          institution: instMatch ? instMatch[0].trim() : (currentInst || 'Institution'),
          year: yearMatch ? yearMatch[0].trim() : currentYear,
        });
      }
    }
  }

  if (education.length === 0) {
    const deg = text.match(/(?:B\.?Tech|Bachelor|M\.?Tech|Master)[^,\n\r]*/i);
    const inst = text.match(/(?:LNJPIT|University|Institute|College)[^,\n\r]*/i);
    if (deg || inst) {
      education.push({
        degree: deg ? deg[0].trim() : 'Degree',
        institution: inst ? inst[0].trim() : 'University',
      });
    }
  }

  // 7. Parse Experience
  const experience: ResumeExperience[] = [];
  const expLines = sections['EXPERIENCE'] || [];
  if (expLines.length > 0) {
    let currentExp: ResumeExperience | null = null;
    const isRoleTitle = (str: string) => /(?:intern|engineer|developer|lead|consultant|associate|manager|specialist|analyst|coordinator|trainee)/i.test(str);
    const isDateString = (str: string) => /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|20\d{2})\s*[-–]\s*(?:Present|\w+\s*20\d{2}|20\d{2})/i.test(str);

    for (const line of expLines) {
      const isBullet = /^[•–\-*]\s*/.test(line);

      if (isBullet) {
        if (!currentExp) {
          currentExp = {
            company: 'Software Company',
            role: 'Software Engineer Intern',
            title: 'Software Engineer Intern',
            highlights: [],
            bullets: [],
          };
        }
        const cleanedBullet = line.replace(/^[•–\-*]\s*/, '').trim();
        if (cleanedBullet) {
          currentExp.highlights.push(cleanedBullet);
          if (!currentExp.bullets) currentExp.bullets = [];
          currentExp.bullets.push(cleanedBullet);
        }
      } else if (line.length > 2) {
        // Non-bullet line
        if (isDateString(line)) {
          if (currentExp) {
            currentExp.duration = line.trim();
            const dateParts = line.split(/[-–]/).map((s) => s.trim());
            currentExp.startDate = dateParts[0] || null;
            currentExp.endDate = dateParts[1] || null;
          }
        } else if (currentExp && currentExp.highlights.length > 0) {
          // A new experience entry is beginning because previous entry already collected bullet points
          if (!currentExp.company) currentExp.company = 'Software Organization';
          currentExp.title = currentExp.role;
          experience.push(currentExp);
          currentExp = null;
        }

        if (!currentExp) {
          // Starting a header for experience
          const parts = line.split(/[|]/).map((s) => s.trim());
          if (parts.length >= 2) {
            if (isRoleTitle(parts[1])) {
              currentExp = {
                company: parts[0],
                role: parts[1],
                title: parts[1],
                location: parts[2] || null,
                highlights: [],
                bullets: [],
              };
            } else {
              currentExp = {
                company: parts[0],
                role: isRoleTitle(parts[0]) ? parts[0] : 'Software Engineer Intern',
                title: isRoleTitle(parts[0]) ? parts[0] : 'Software Engineer Intern',
                location: parts[1] || null,
                highlights: [],
                bullets: [],
              };
            }
          } else {
            if (isRoleTitle(line)) {
              currentExp = {
                company: '',
                role: line.trim(),
                title: line.trim(),
                highlights: [],
                bullets: [],
              };
            } else {
              currentExp = {
                company: line.trim(),
                role: 'Software Engineer Intern',
                title: 'Software Engineer Intern',
                highlights: [],
                bullets: [],
              };
            }
          }
        } else if (currentExp && currentExp.highlights.length === 0 && (!currentExp.company || currentExp.company === '')) {
          // Line 2 provides company and location
          const parts = line.split(/[|]/).map((s) => s.trim());
          currentExp.company = parts[0];
          if (parts[1]) currentExp.location = parts[1];
        } else if (currentExp && currentExp.highlights.length === 0 && currentExp.company && line.includes('|')) {
          const parts = line.split(/[|]/).map((s) => s.trim());
          if (!currentExp.location) currentExp.location = parts[parts.length - 1];
        }
      }
    }

    if (currentExp && (currentExp.highlights.length > 0 || currentExp.company)) {
      if (!currentExp.company) currentExp.company = 'Software Organization';
      currentExp.title = currentExp.role;
      experience.push(currentExp);
    }
  }

  // 8. Parse Projects
  const projects: ResumeProject[] = [];
  const projLines = sections['PROJECTS'] || [];
  if (projLines.length > 0) {
    let currentProj: ResumeProject | null = null;
    for (const line of projLines) {
      const isBullet = /^[•–\-*]\s*/.test(line);
      const isTechLine = /^(?:Technologies|Tech\s*Stack|Tools|Built\s*with|Stack):/i.test(line);

      if (isTechLine && currentProj) {
        const rawTech = line.replace(/^(?:Technologies|Tech\s*Stack|Tools|Built\s*with|Stack):\s*/i, '').trim();
        currentProj.techStack = rawTech.split(/[,|]/).map((t) => t.trim()).filter(Boolean);
      } else if (!isBullet && line.length > 3) {
        if (currentProj && (currentProj.highlights.length > 0 || currentProj.title)) {
          projects.push(currentProj);
        }
        const dateMatch = line.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|20\d{2})\s*[-–]\s*(?:Present|\w+\s*20\d{2}|20\d{2})/i);
        const title = line.replace(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|20\d{2})\s*[-–]\s*(?:Present|\w+\s*20\d{2}|20\d{2})/i, '').replace(/^[•–\-*]\s*/, '').trim();
        currentProj = {
          title: title || 'Software Project',
          duration: dateMatch ? dateMatch[0].trim() : null,
          techStack: [],
          highlights: [],
        };
      } else if (currentProj && isBullet) {
        const cleanedBullet = line.replace(/^[•–\-*]\s*/, '').trim();
        if (cleanedBullet) {
          currentProj.highlights.push(cleanedBullet);
        }
      }
    }
    if (currentProj && (currentProj.highlights.length > 0 || currentProj.title)) {
      projects.push(currentProj);
    }
  }

  // 9. Parse Achievements
  const achievements: Array<string | ResumeAchievement> = [];
  const achLines = sections['ACHIEVEMENTS'] || [];
  for (const line of achLines) {
    const cleaned = line.replace(/^[•–\-*]\s*/, '').trim();
    if (cleaned.length > 5) {
      achievements.push(cleaned);
    }
  }

  // 10. Parse Leadership
  const leadership: ResumeLeadership[] = [];
  const leadLines = sections['LEADERSHIP'] || [];
  for (const line of leadLines) {
    const cleaned = line.replace(/^[•–\-*]\s*/, '').trim();
    if (cleaned.length > 5) {
      const parts = cleaned.split(/[,–-]/).map((s) => s.trim());
      leadership.push({
        position: parts[0] || 'Coordinator',
        organization: parts[1] || 'Student Organization',
        highlights: [cleaned],
      });
    }
  }

  const topSkills = [
    ...foundSkills.languages,
    ...foundSkills.frameworks,
    ...foundSkills.databases,
  ].slice(0, 5).join(', ');

  return {
    name,
    email,
    phone,
    location: null,
    education,
    skills: foundSkills,
    experience,
    projects,
    certifications: [],
    achievements,
    leadership: leadership.length > 0 ? leadership : undefined,
    summary: `${name} is a software professional with hands-on experience in ${topSkills || 'software engineering'}.`,
  };
}

/**
 * Uses the resilient AI dispatcher (Gemini primary + OpenRouter fallback)
 * to structure raw resume text into a rich, strictly verified candidate profile.
 */
async function structureResumeWithAI(rawText: string): Promise<StructuredResumeProfile> {
  const prompt = `You are an expert, high-fidelity resume information extraction engine. Analyze the following resume text and convert it into a strictly verified, structured JSON profile.

CRITICAL EXTRACTION PHILOSOPHY:
1. High-Fidelity Extraction, NOT Summarization: Extract EVERY factual piece of information present in the resume into its appropriate field.
2. Education: Extract every education entry separately. Separate degree, field of study, institution, board/university, years, gpa, and coursework. AVOID table headers (like "Institute/BoardCGPA/PercentageYear") being treated as actual institutions.
3. Experience: Extract EVERY internship and job separately. Preserve company name, exact job title, employment type (internship vs full-time), dates/duration, technologies used, and EVERY individual bullet point of responsibilities/achievements.
4. Projects: Extract EVERY project separately. Preserve exact project title, dates, technologies/frameworks/databases/APIs used, architecture/implementation details, and EVERY bullet point of technical highlights and metrics.
5. Technical Skills: Extract ALL explicitly stated skills across categories (languages, frontend, backend, frameworks, databases, aiMl, cloudDevOps, tools, coreCs, apisIntegrations). Do NOT truncate or omit stated skills.
6. Achievements & Awards: Extract all achievements, hackathon ranks, sports honors, and awards explicitly stated.
7. Positions of Responsibility / Leadership: Extract student coordinator roles, event organizer roles, and leadership positions.
8. Anti-Hallucination: Extract ONLY facts explicitly stated in the text. NEVER invent job titles, companies, metrics, dates, or skills. If a detail is absent, leave it null or empty array.
9. Output valid JSON only without markdown fences or preamble.

Target JSON Schema:
{
  "name": "Candidate full name",
  "email": "candidate email or null",
  "phone": "candidate phone or null",
  "location": "candidate location or null",
  "education": [
    {
      "degree": "Degree title (e.g. Bachelor of Technology)",
      "fieldOfStudy": "Computer Science and Engineering or null",
      "institution": "LNJPIT or college name",
      "boardOrUniversity": "Bihar Engineering University or board name",
      "year": "2022-2026 or graduation year",
      "gpa": "7.00 or percentage if stated",
      "relevantCoursework": ["Data Structures", "DBMS", ...]
    }
  ],
  "skills": {
    "languages": ["C", "C++", "Python", "JavaScript", "TypeScript", ...],
    "frontend": ["React.js", "HTML5", "CSS3", "Tailwind CSS", "Bootstrap", ...],
    "backend": ["Node.js", ...],
    "frameworks": ["React", "Next.js", "Flask", ...],
    "databases": ["SQLite", "PostgreSQL", "MongoDB", "Drizzle ORM", ...],
    "aiMl": ["Google Gemini", "OpenRouter", "Scikit-learn", "XGBoost", "Random Forest", "SHAP", "Pandas", "NumPy", ...],
    "dataScience": ["Pandas", "NumPy", ...],
    "cloudDevOps": ["Docker", "Git", ...],
    "tools": ["Git", "GitHub", "VS Code", "Postman", ...],
    "apisIntegrations": ["Gmail API", "OAuth 2.0", "REST APIs", ...],
    "coreCs": ["Data Structures and Algorithms", "OOP", "DBMS", "Operating Systems", ...],
    "other": []
  },
  "experience": [
    {
      "role": "Web Development Intern",
      "company": "Invigo Infotech",
      "employmentType": "Internship (On-Site)",
      "startDate": "Dec 2025",
      "endDate": "Jan 2026",
      "duration": "Dec 2025 – Jan 2026",
      "location": "On-Site",
      "description": "Short overview if present",
      "responsibilities": ["Developed responsive web applications..."],
      "highlights": [
        "Developed responsive web applications using HTML5, CSS3, JavaScript, Flexbox, and CSS Grid.",
        "Built interactive user interfaces with DOM manipulation, form validation, and dynamic content rendering.",
        "Utilized Git/GitHub, VS Code, Browser Developer Tools, and npm for development, debugging, and version control."
      ],
      "technologies": ["HTML5", "CSS3", "JavaScript", "Flexbox", "CSS Grid"],
      "tools": ["Git", "GitHub", "VS Code", "npm"]
    }
  ],
  "projects": [
    {
      "title": "AI Job Outreach Agent",
      "duration": "Jul 2025 – Present",
      "description": "Full-stack AI-powered job outreach platform automating company classification and recruiter outreach",
      "techStack": ["Next.js", "TypeScript", "React", "Gemini", "OpenRouter", "Gmail API", "SQLite", "Drizzle ORM", "Tailwind CSS"],
      "highlights": [
        "Engineered a full-stack AI-powered job outreach platform using Next.js 16, React, and TypeScript, automating company classification, resume-grounded email generation, and personalized recruiter outreach via Gmail API.",
        "Built an autonomous multi-stage AI pipeline with Google Gemini and OpenRouter fallback, implementing asynchronous processing, round-based retries, progressive generation, provider-isolated rate-limit handling, and bounded error recovery.",
        "Implemented secure Gmail OAuth 2.0 with AES-256-GCM credential encryption, MIME construction, persistent SQLite queues, and timezone-aware scheduling with 10 AM–4 PM IST windows, 3-minute pacing, and 144-hour cooldowns.",
        "Developed a fault-tolerant background worker using SQLite transactions, atomic lease-based concurrency control, stale-job recovery, batch isolation, and deduplication safeguards to prevent duplicate processing and unsafe outreach."
      ]
    }
  ],
  "certifications": [
    { "name": "Certification Name", "issuer": "Issuer Organization", "date": "Date" }
  ],
  "achievements": [
    { "title": "Blind Coding Hackathon Runner-Up (2 Times)", "description": "Secured 2nd position in college-level Blind Coding Hackathon competitions.", "rank": "2nd" }
  ],
  "leadership": [
    { "position": "Training & Placement Coordinator", "organization": "Training & Placement Cell, LNJPIT Chapra", "duration": "Jun 2023 – Jul 2026" }
  ],
  "summary": "Verbatim summary from resume if present, or a concise factual 2-sentence summary."
}

Resume Text to Analyze:
---
${rawText.slice(0, 30000)}
---`;

  const aiRes = await callAi(prompt, {
    temperature: 0.1,
    priority: GEMINI_PRIORITIES.COMPANY_CLASSIFICATION,
    taskName: 'resume-structuring',
  });

  const responseText = aiRes.text;
  const cleaned = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AI response is not a valid JSON object');
  }

  // Normalize education
  const education: ResumeEducation[] = Array.isArray(parsed.education)
    ? parsed.education.map((e: Record<string, any>) => ({
        degree: String(e.degree || '').trim(),
        fieldOfStudy: e.fieldOfStudy ? String(e.fieldOfStudy).trim() : undefined,
        institution: String(e.institution || '').trim(),
        boardOrUniversity: e.boardOrUniversity ? String(e.boardOrUniversity).trim() : undefined,
        year: e.year ? String(e.year).trim() : undefined,
        gpa: e.gpa ? String(e.gpa).trim() : undefined,
        relevantCoursework: Array.isArray(e.relevantCoursework) ? e.relevantCoursework.map(String) : undefined,
        otherDetails: e.otherDetails ? String(e.otherDetails).trim() : undefined,
      }))
    : [];

  // Normalize skills
  const skills: ResumeSkills = {
    languages: Array.isArray(parsed.skills?.languages) ? parsed.skills.languages.map(String) : [],
    frameworks: Array.isArray(parsed.skills?.frameworks) ? parsed.skills.frameworks.map(String) : [],
    databases: Array.isArray(parsed.skills?.databases) ? parsed.skills.databases.map(String) : [],
    cloudDevOps: Array.isArray(parsed.skills?.cloudDevOps) ? parsed.skills.cloudDevOps.map(String) : [],
    tools: Array.isArray(parsed.skills?.tools) ? parsed.skills.tools.map(String) : [],
    frontend: Array.isArray(parsed.skills?.frontend) ? parsed.skills.frontend.map(String) : undefined,
    backend: Array.isArray(parsed.skills?.backend) ? parsed.skills.backend.map(String) : undefined,
    aiMl: Array.isArray(parsed.skills?.aiMl) ? parsed.skills.aiMl.map(String) : undefined,
    dataScience: Array.isArray(parsed.skills?.dataScience) ? parsed.skills.dataScience.map(String) : undefined,
    apisIntegrations: Array.isArray(parsed.skills?.apisIntegrations) ? parsed.skills.apisIntegrations.map(String) : undefined,
    coreCs: Array.isArray(parsed.skills?.coreCs) ? parsed.skills.coreCs.map(String) : undefined,
    other: Array.isArray(parsed.skills?.other) ? parsed.skills.other.map(String) : [],
  };

  // Normalize experience
  const experience: ResumeExperience[] = Array.isArray(parsed.experience)
    ? parsed.experience.map((exp: Record<string, any>) => ({
        role: String(exp.role || '').trim(),
        company: String(exp.company || '').trim(),
        employmentType: exp.employmentType ? String(exp.employmentType).trim() : undefined,
        startDate: exp.startDate ? String(exp.startDate).trim() : undefined,
        endDate: exp.endDate ? String(exp.endDate).trim() : undefined,
        duration: exp.duration ? String(exp.duration).trim() : undefined,
        location: exp.location ? String(exp.location).trim() : undefined,
        description: exp.description ? String(exp.description).trim() : undefined,
        responsibilities: Array.isArray(exp.responsibilities) ? exp.responsibilities.map(String) : undefined,
        highlights: Array.isArray(exp.highlights) ? exp.highlights.map(String) : [],
        technologies: Array.isArray(exp.technologies) ? exp.technologies.map(String) : undefined,
        tools: Array.isArray(exp.tools) ? exp.tools.map(String) : undefined,
        metrics: Array.isArray(exp.metrics) ? exp.metrics.map(String) : undefined,
      }))
    : [];

  // Normalize projects
  const projects: ResumeProject[] = Array.isArray(parsed.projects)
    ? parsed.projects.map((p: Record<string, any>) => ({
        title: String(p.title || '').trim(),
        duration: p.duration ? String(p.duration).trim() : null,
        description: p.description ? String(p.description).trim() : undefined,
        problemSolved: p.problemSolved ? String(p.problemSolved).trim() : null,
        techStack: Array.isArray(p.techStack) ? p.techStack.map(String) : [],
        frameworks: Array.isArray(p.frameworks) ? p.frameworks.map(String) : undefined,
        databases: Array.isArray(p.databases) ? p.databases.map(String) : undefined,
        apis: Array.isArray(p.apis) ? p.apis.map(String) : undefined,
        architecture: p.architecture ? String(p.architecture).trim() : null,
        implementationDetails: p.implementationDetails ? String(p.implementationDetails).trim() : null,
        highlights: Array.isArray(p.highlights) ? p.highlights.map(String) : [],
        metrics: Array.isArray(p.metrics) ? p.metrics.map(String) : undefined,
        deployment: p.deployment ? String(p.deployment).trim() : null,
      }))
    : [];

  // Normalize certifications
  const certifications = Array.isArray(parsed.certifications)
    ? parsed.certifications.map((c: any) =>
        typeof c === 'string'
          ? c
          : {
              name: String(c.name || '').trim(),
              issuer: c.issuer ? String(c.issuer).trim() : null,
              date: c.date ? String(c.date).trim() : null,
              credentialId: c.credentialId ? String(c.credentialId).trim() : null,
              url: c.url ? String(c.url).trim() : null,
            }
      )
    : [];

  // Normalize achievements
  const achievements = Array.isArray(parsed.achievements)
    ? parsed.achievements.map((a: any) =>
        typeof a === 'string'
          ? a
          : {
              title: String(a.title || '').trim(),
              description: a.description ? String(a.description).trim() : null,
              event: a.event ? String(a.event).trim() : null,
              rank: a.rank ? String(a.rank).trim() : null,
              count: a.count ? String(a.count).trim() : null,
              date: a.date ? String(a.date).trim() : null,
              metrics: a.metrics ? String(a.metrics).trim() : null,
            }
      )
    : [];

  // Normalize leadership
  const leadership: ResumeLeadership[] = Array.isArray(parsed.leadership)
    ? parsed.leadership.map((lead: Record<string, any>) => ({
        position: String(lead.position || '').trim(),
        organization: String(lead.organization || '').trim(),
        duration: lead.duration ? String(lead.duration).trim() : null,
        startDate: lead.startDate ? String(lead.startDate).trim() : null,
        endDate: lead.endDate ? String(lead.endDate).trim() : null,
        description: lead.description ? String(lead.description).trim() : null,
        responsibilities: Array.isArray(lead.responsibilities) ? lead.responsibilities.map(String) : undefined,
        highlights: Array.isArray(lead.highlights) ? lead.highlights.map(String) : [],
      }))
    : [];

  return {
    name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'Applicant',
    email: typeof parsed.email === 'string' ? parsed.email.trim() : null,
    phone: typeof parsed.phone === 'string' ? parsed.phone.trim() : null,
    location: typeof parsed.location === 'string' ? parsed.location.trim() : null,
    education,
    skills,
    experience,
    projects,
    certifications,
    achievements,
    leadership: leadership.length > 0 ? leadership : undefined,
    summary:
      typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : 'Motivated software engineering professional seeking fresher and entry-level opportunities.',
  };
}

/**
 * Main resume parsing and structuring entry point.
 */
export async function parseAndStructureResume(
  buffer: Buffer
): Promise<{ rawText: string; profile: StructuredResumeProfile }> {
  const rawText = await extractPdfText(buffer);
  if (!rawText || rawText.trim().length === 0) {
    throw new Error('Unable to extract text from the provided resume PDF. Please ensure the file is not empty.');
  }

  if (getGeminiClient() || isOpenRouterConfigured()) {
    try {
      const profile = await structureResumeWithAI(rawText);
      return { rawText, profile };
    } catch (aiErr) {
      console.warn('[ResumeParser] AI resume structuring failed, falling back to section-aware heuristic parsing:', aiErr);
    }
  }

  const profile = heuristicParseResume(rawText);
  return { rawText, profile };
}
