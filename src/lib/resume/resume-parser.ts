import { extractPdfText } from '@/lib/parsers/pdf-parser';
import { callGemini, getGeminiClient } from '@/lib/ai/gemini-client';
import type { StructuredResumeProfile } from '@/types';

/**
 * Heuristic fallback parser when Gemini API is unavailable.
 * Extracts basic name, email, skills, and projects using regex and text patterns.
 */
function heuristicParseResume(text: string): StructuredResumeProfile {
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

  // 4. Skills extraction via known keywords
  const skillKeywords = {
    languages: ['JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'C', 'Go', 'Rust', 'Ruby', 'PHP', 'SQL', 'HTML', 'CSS'],
    frameworks: ['React', 'Next.js', 'Node.js', 'Express', 'Vue', 'Angular', 'Django', 'Flask', 'Spring Boot', 'Tailwind', 'Redux'],
    databases: ['PostgreSQL', 'MySQL', 'MongoDB', 'SQLite', 'Redis', 'Firebase', 'Supabase'],
    cloudDevOps: ['AWS', 'GCP', 'Azure', 'Docker', 'Kubernetes', 'CI/CD', 'Git', 'GitHub Actions', 'Vercel'],
    tools: ['Git', 'VS Code', 'Postman', 'Figma', 'Linux', 'Jira'],
  };

  const foundSkills: StructuredResumeProfile['skills'] = {
    languages: [],
    frameworks: [],
    databases: [],
    cloudDevOps: [],
    tools: [],
    other: [],
  };

  for (const [cat, kws] of Object.entries(skillKeywords)) {
    for (const kw of kws) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(?:^|\\s|[\\(,\/])${escaped}(?:$|\\s|[\\),\/.])`, 'i');
      if (regex.test(text)) {
        foundSkills[cat as keyof typeof foundSkills].push(kw);
      }
    }
  }

  // 5. Basic education
  const education: StructuredResumeProfile['education'] = [];
  const degreeMatch = text.match(/(B\.?Tech|Bachelor|M\.?Tech|Master|B\.?S|M\.?S|B\.?E)[^,\n\r]*/i);
  const collegeMatch = text.match(/(University|Institute|College|LNJPIT|IIT|NIT)[^,\n\r]*/i);

  if (degreeMatch || collegeMatch) {
    education.push({
      degree: degreeMatch ? degreeMatch[0].trim() : 'Undergraduate Degree',
      institution: collegeMatch ? collegeMatch[0].trim() : 'University',
    });
  }

  return {
    name,
    email,
    phone,
    location: null,
    education,
    skills: foundSkills,
    experience: [],
    projects: [],
    certifications: [],
    achievements: [],
    summary: `${name} is a software developer with skills in ${foundSkills.languages.concat(foundSkills.frameworks).slice(0, 5).join(', ')}.`,
  };
}

/**
 * Uses Gemini AI to structure raw resume text into a verified professional profile.
 */
async function structureResumeWithAI(rawText: string): Promise<StructuredResumeProfile> {
  const prompt = `You are an expert resume parsing engine. Analyze the following resume text and convert it into a strictly verified, structured JSON profile.

CRITICAL ANTI-HALLUCINATION INSTRUCTIONS:
1. Extract ONLY facts explicitly stated in the text.
2. NEVER invent job titles, companies, achievements, years of experience, or skills.
3. Do NOT upgrade "familiar with" into "expert".
4. If a field or detail is not mentioned, leave it null or empty array.
5. Do not include markdown code fences or conversational remarks. Respond with valid JSON only.

Target JSON Schema:
{
  "name": "Full name of candidate",
  "email": "candidate email or null",
  "phone": "candidate phone or null",
  "location": "candidate city/state/country or null",
  "education": [
    {
      "degree": "B.Tech in Computer Science, etc.",
      "institution": "University / College name",
      "year": "Graduation year or date range (e.g. 2022-2026)",
      "gpa": "GPA or percentage if mentioned, else null"
    }
  ],
  "skills": {
    "languages": ["JavaScript", "TypeScript", ...],
    "frameworks": ["React", "Next.js", ...],
    "databases": ["PostgreSQL", ...],
    "cloudDevOps": ["AWS", "Docker", ...],
    "tools": ["Git", "Postman", ...],
    "other": ["REST APIs", "Agile", ...]
  },
  "experience": [
    {
      "role": "Job / Internship title",
      "company": "Company / Organization name",
      "duration": "Duration / dates",
      "description": "Short summary",
      "highlights": ["Key bullet point 1", "Key bullet point 2"]
    }
  ],
  "projects": [
    {
      "title": "Project name",
      "description": "Brief description of what was built",
      "techStack": ["React", "Node.js", ...],
      "highlights": ["Bullet point of impact or technical achievement"]
    }
  ],
  "certifications": ["Certification name 1", ...],
  "achievements": ["Achievement or award 1", ...],
  "summary": "Concise 2-sentence objective or professional summary derived strictly from facts above."
}

Resume Text to Analyze:
---
${rawText.slice(0, 20000)}
---`;

  const response = await callGemini(prompt, { temperature: 0.1 });
  const cleaned = response.replace(/```json/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  // Validate the required structure
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AI response is not an object');
  }

  const profile: StructuredResumeProfile = {
    name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'Applicant',
    email: typeof parsed.email === 'string' ? parsed.email.trim() : null,
    phone: typeof parsed.phone === 'string' ? parsed.phone.trim() : null,
    location: typeof parsed.location === 'string' ? parsed.location.trim() : null,
    education: Array.isArray(parsed.education)
      ? parsed.education.map((e: Record<string, string>) => ({
          degree: String(e.degree || '').trim(),
          institution: String(e.institution || '').trim(),
          year: e.year ? String(e.year).trim() : undefined,
          gpa: e.gpa ? String(e.gpa).trim() : undefined,
        }))
      : [],
    skills: {
      languages: Array.isArray(parsed.skills?.languages) ? parsed.skills.languages.map(String) : [],
      frameworks: Array.isArray(parsed.skills?.frameworks) ? parsed.skills.frameworks.map(String) : [],
      databases: Array.isArray(parsed.skills?.databases) ? parsed.skills.databases.map(String) : [],
      cloudDevOps: Array.isArray(parsed.skills?.cloudDevOps) ? parsed.skills.cloudDevOps.map(String) : [],
      tools: Array.isArray(parsed.skills?.tools) ? parsed.skills.tools.map(String) : [],
      other: Array.isArray(parsed.skills?.other) ? parsed.skills.other.map(String) : [],
    },
    experience: Array.isArray(parsed.experience)
      ? parsed.experience.map((exp: Record<string, unknown>) => ({
          role: String(exp.role || '').trim(),
          company: String(exp.company || '').trim(),
          duration: exp.duration ? String(exp.duration).trim() : undefined,
          description: exp.description ? String(exp.description).trim() : undefined,
          highlights: Array.isArray(exp.highlights) ? exp.highlights.map(String) : [],
        }))
      : [],
    projects: Array.isArray(parsed.projects)
      ? parsed.projects.map((p: Record<string, unknown>) => ({
          title: String(p.title || '').trim(),
          description: p.description ? String(p.description).trim() : undefined,
          techStack: Array.isArray(p.techStack) ? p.techStack.map(String) : [],
          highlights: Array.isArray(p.highlights) ? p.highlights.map(String) : [],
        }))
      : [],
    certifications: Array.isArray(parsed.certifications) ? parsed.certifications.map(String) : [],
    achievements: Array.isArray(parsed.achievements) ? parsed.achievements.map(String) : [],
    summary:
      typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : 'Motivated software professional interested in technology opportunities.',
  };

  return profile;
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

  if (getGeminiClient()) {
    try {
      const profile = await structureResumeWithAI(rawText);
      return { rawText, profile };
    } catch (aiErr) {
      console.warn('Gemini resume structuring failed, falling back to heuristic parsing:', aiErr);
    }
  }

  const profile = heuristicParseResume(rawText);
  return { rawText, profile };
}
