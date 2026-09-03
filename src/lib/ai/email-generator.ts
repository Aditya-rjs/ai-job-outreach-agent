import { callGemini, getGeminiClient } from './gemini-client';
import { checkEmailSimilarity } from './similarity';
import type { StructuredResumeProfile, GeneratedEmailResult } from '@/types';

export interface EmailGenerationInput {
  profile: StructuredResumeProfile;
  companyName: string;
  contactName?: string | null;
  designation?: string | null;
  companyWebsite?: string | null;
  companyLocation?: string | null;
  relevanceReason?: string | null;
  recentEmails?: string[];
  preferredStrategy?: string;
}

const STRATEGIES = [
  'skills-focused',
  'project-focused',
  'company-focused',
  'concise-direct',
  'technical',
  'career-interest-focused',
] as const;

/**
 * Heuristic email generation fallback when Gemini API is unavailable.
 * Generates natural variations based on strategy to prevent mass-template duplication.
 */
function heuristicGenerateEmail(
  input: EmailGenerationInput,
  strategyIndex = 0
): GeneratedEmailResult {
  const { profile, companyName, contactName, designation, relevanceReason } = input;

  const candidateName = profile.name || 'Aditya Raj Singh';
  const degree = profile.education[0]?.degree || 'Computer Science Engineering graduate';
  const institution = profile.education[0]?.institution || 'LNJPIT Chapra';
  const topLanguages = (profile.skills.languages || []).slice(0, 3).join(', ') || 'JavaScript, TypeScript, SQL';
  const topFrameworks = (profile.skills.frameworks || []).slice(0, 3).join(', ') || 'React, Next.js, Node.js';
  const topProject = profile.projects[0]?.title || 'web-based software platforms';
  const projectTech = (profile.projects[0]?.techStack || []).slice(0, 3).join(', ') || topFrameworks;

  const greeting = contactName && contactName.trim()
    ? `Dear ${contactName.trim()},`
    : 'Hello Recruitment Team,';

  const signature = `Best regards,\n${candidateName}\n${degree}${profile.email ? `\nEmail: ${profile.email}` : ''}${profile.phone ? `\nPhone: ${profile.phone}` : ''}`;

  const availableStrategies = STRATEGIES;
  const chosenStrategy = input.preferredStrategy || availableStrategies[strategyIndex % availableStrategies.length];

  let subject = '';
  let bodyParagraphs: string[] = [];
  const personalizationPoints: string[] = [];

  if (contactName) personalizationPoints.push(`Addressed directly to ${contactName}${designation ? ` (${designation})` : ''}`);
  personalizationPoints.push(`Referenced ${companyName}`);
  if (relevanceReason) personalizationPoints.push(`Aligned with ${relevanceReason}`);

  switch (chosenStrategy) {
    case 'project-focused':
      subject = `Software Engineering Inquiry — ${candidateName}`;
      bodyParagraphs = [
        greeting,
        `I am writing to express my strong interest in software engineering and technical opportunities at ${companyName}. As a ${degree} from ${institution}, I have focused heavily on building production-ready applications, including ${topProject} using ${projectTech}.`,
        `Given ${companyName}'s technological focus, I would welcome the opportunity to contribute my skills in ${topLanguages} and ${topFrameworks} to your engineering team. I pride myself on writing clean, scalable code and learning new systems quickly.`,
        `I would be grateful if you could keep my profile in mind for any current or upcoming software engineering openings or internships. My resume is attached for your review, and I would be delighted to discuss how my background aligns with your team's needs.`,
        signature,
      ];
      break;

    case 'company-focused':
      subject = `Exploring Software Opportunities at ${companyName} — ${candidateName}`;
      bodyParagraphs = [
        greeting,
        `I have been following ${companyName}'s work in technology and engineering with great admiration. I am reaching out to explore potential entry-level software engineering or internship opportunities where I could add value.`,
        `I recently completed my ${degree} at ${institution}, developing hands-on experience in full-stack development with ${topFrameworks} as well as ${topLanguages}. Through rigorous project work such as building ${topProject}, I have developed strong problem-solving skills and a deep enthusiasm for robust software development.`,
        `If ${companyName} has any suitable openings now or in the near future, I would appreciate the chance to connect. Thank you for your time and consideration.`,
        signature,
      ];
      break;

    case 'concise-direct':
      subject = `Software Engineer Candidate — ${candidateName}`;
      bodyParagraphs = [
        greeting,
        `I am reaching out to inquire about software engineering or developer opportunities at ${companyName}. I am a ${degree} with practical experience across ${topLanguages} and ${topFrameworks}.`,
        `Recently, I developed ${topProject}, implementing scalable architecture with ${projectTech}. I am eager to bring this same dedication to ${companyName}'s technical initiatives.`,
        `Please find my attached resume for your consideration. I would welcome the opportunity for a brief conversation if there is an alignment with your hiring goals.`,
        signature,
      ];
      break;

    case 'technical':
      subject = `Full-Stack / Software Engineering Opportunities — ${candidateName}`;
      bodyParagraphs = [
        greeting,
        `I am writing to inquire about software engineering roles at ${companyName}. With a background in ${degree} from ${institution}, my core technical strengths center around ${topLanguages}, along with ${topFrameworks}.`,
        `In my recent work on ${topProject}, I focused on system architecture, database optimization, and delivering clean, maintainable user interfaces. I am excited by the engineering standards at ${companyName} and would love to contribute to your software products.`,
        `Should your team have any relevant openings or upcoming internship opportunities, I would be thrilled to be considered. Thank you for your time.`,
        signature,
      ];
      break;

    case 'career-interest-focused':
      subject = `Software Engineering Opportunities at ${companyName} — ${candidateName}`;
      bodyParagraphs = [
        greeting,
        `I am writing to express my strong enthusiasm for joining ${companyName} in a software engineering capacity. With my academic background in ${degree} from ${institution}, I have prepared diligently for a career building robust, high-performance software.`,
        `My technical background includes solid hands-on development in ${topLanguages} and ${topFrameworks}. Building applications such as ${topProject} taught me how to deliver scalable solutions from database modeling to responsive frontend interfaces.`,
        `I would love the opportunity to explore any entry-level software engineer, developer, or trainee positions currently or soon to be available with your team. My resume is attached for your review.`,
        signature,
      ];
      break;

    default: // skills-focused
      subject = `Interest in Software Engineering Roles at ${companyName} — ${candidateName}`;
      bodyParagraphs = [
        greeting,
        `I hope this email finds you well. I am reaching out to express my keen interest in software engineering opportunities with ${companyName}.`,
        `As a ${degree} from ${institution}, I have cultivated a solid foundation in ${topLanguages} and modern frameworks including ${topFrameworks}. During my studies, I led the development of ${topProject}, which strengthened my expertise in full-cycle software delivery and teamwork.`,
        `I would love the opportunity to bring my passion for software engineering to ${companyName}. Please feel free to review my attached resume. I look forward to the possibility of speaking with your team.`,
        signature,
      ];
      break;
  }

  return {
    subject,
    body: bodyParagraphs.join('\n\n'),
    strategy: chosenStrategy,
    personalization_points: personalizationPoints,
  };
}

/**
 * Builds the AI prompt for Gemini to generate a naturally unique, highly personalized email.
 */
function buildGenerationPrompt(
  input: EmailGenerationInput,
  strategy: string,
  avoidSimilarGuidance?: string
): string {
  const { profile, companyName, contactName, designation, companyWebsite, companyLocation, relevanceReason } = input;

  const candidateSkills = [
    ...(profile.skills.languages || []),
    ...(profile.skills.frameworks || []),
    ...(profile.skills.databases || []),
  ].slice(0, 10).join(', ');

  const candidateProjects = (profile.projects || [])
    .slice(0, 3)
    .map((p) => `- ${p.title}: ${p.description || ''} (Tech: ${p.techStack.join(', ')})`)
    .join('\n');

  const candidateEdu = profile.education
    .map((e) => `${e.degree} from ${e.institution}${e.year ? ` (${e.year})` : ''}`)
    .join('; ');

  return `You are a professional career communication specialist writing a personalized, high-conviction job-outreach email from a candidate to an HR recruiter or hiring manager.

=== CANDIDATE FACTS (STRICT SOURCE OF TRUTH) ===
- Name: ${profile.name}
- Education: ${candidateEdu || 'Computer Science Engineering background'}
- Verified Skills: ${candidateSkills || 'Software Development'}
- Verified Projects:
${candidateProjects || '- Full-stack software engineering projects'}
- Experience Summary: ${profile.summary || ''}
${profile.email ? `- Email: ${profile.email}` : ''}
${profile.phone ? `- Phone: ${profile.phone}` : ''}

=== RECIPIENT & COMPANY CONTEXT ===
- Company: ${companyName}
${companyWebsite ? `- Website: ${companyWebsite}` : ''}
${companyLocation ? `- Location: ${companyLocation}` : ''}
- Recipient Name: ${contactName && contactName.trim() ? contactName.trim() : 'NOT PROVIDED (use a generic professional greeting like "Hello Hiring Team," or "Hello Recruitment Team,")'}
${designation ? `- Recipient Designation: ${designation}` : ''}
${relevanceReason ? `- Verified Relevance: ${relevanceReason}` : ''}

=== STRATEGY FOR THIS EMAIL ===
Strategy: "${strategy}"

=== CRITICAL RULES ===
1. Length: 100 to 180 words. Be concise, punchy, respectful, and direct.
2. Anti-Hallucination: Mention ONLY skills, projects, and educational credentials present in the CANDIDATE FACTS above. DO NOT invent skills, certifications, job titles, or experience.
3. Company Context: Reference ${companyName} naturally. DO NOT invent fake company news, fake referrals, fake mutual connections, or claim knowledge of unannounced openings.
4. Voice & Tone: Confident, professional, enthusiastic. Do NOT beg, apologize for reaching out, or sound like a generic mass marketing mailer.
5. Opening: Avoid cliché openings like "I hope this email finds you well" if possible; vary the opening naturally according to the strategy.
6. Signature: Close with a professional sign-off and the candidate's name and credentials from the facts.
${avoidSimilarGuidance ? `7. DIVERSITY REQUIREMENT: ${avoidSimilarGuidance}` : ''}

Respond ONLY with valid JSON matching this exact schema:
{
  "subject": "Clear, professional, natural subject line",
  "body": "Complete email body including greeting, paragraphs, and signature",
  "strategy": "${strategy}",
  "personalization_points": [
    "Specific personalization point 1",
    "Specific personalization point 2"
  ]
}
Do not wrap in markdown fences or include explanations.`;
}

/**
 * Generates an email using Gemini AI with automatic similarity check and retry.
 */
export async function generatePersonalizedEmail(
  input: EmailGenerationInput
): Promise<GeneratedEmailResult> {
  const dynamicWordsToIgnore = [
    input.companyName,
    input.contactName || '',
    input.profile.name,
  ].filter(Boolean);

  const availableStrategies = [...STRATEGIES];
  const selectedStrategy =
    input.preferredStrategy ||
    availableStrategies[Math.floor(Math.random() * availableStrategies.length)];

  if (!getGeminiClient()) {
    // If Gemini API is not configured, generate via diversified heuristic engine
    const stratIdx = availableStrategies.indexOf(selectedStrategy as (typeof STRATEGIES)[number]);
    return heuristicGenerateEmail(input, stratIdx >= 0 ? stratIdx : 0);
  }

  let attempt = 0;
  const maxAttempts = 3;
  let avoidGuidance = '';

  while (attempt < maxAttempts) {
    attempt++;
    const currentStrategy = attempt === 1 ? selectedStrategy : availableStrategies[(attempt + 1) % availableStrategies.length];
    const prompt = buildGenerationPrompt(input, currentStrategy, avoidGuidance);

    try {
      const responseText = await callGemini(prompt, { temperature: 0.3 + attempt * 0.1 });
      const cleaned = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      if (
        parsed &&
        typeof parsed.subject === 'string' &&
        typeof parsed.body === 'string' &&
        parsed.subject.trim().length > 0 &&
        parsed.body.trim().length > 0
      ) {
        const generatedResult: GeneratedEmailResult = {
          subject: parsed.subject.trim(),
          body: parsed.body.trim(),
          strategy: typeof parsed.strategy === 'string' ? parsed.strategy : currentStrategy,
          personalization_points: Array.isArray(parsed.personalization_points)
            ? parsed.personalization_points.map(String)
            : [`Personalized for ${input.companyName}`],
        };

        // Check similarity against recent emails
        if (input.recentEmails && input.recentEmails.length > 0) {
          const { isTooSimilar, maxSimilarity } = checkEmailSimilarity(
            generatedResult.body,
            input.recentEmails,
            dynamicWordsToIgnore,
            0.65
          );

          if (isTooSimilar && attempt < maxAttempts) {
            console.log(`Generated email was ${(maxSimilarity * 100).toFixed(1)}% similar to recent emails. Regenerating with different strategy...`);
            avoidGuidance = 'The previous draft was structurally too similar to another email. Vary the sentence structure, paragraph order, and opening phrasing significantly.';
            continue;
          }
        }

        return generatedResult;
      }
    } catch (err) {
      console.warn(`Gemini email generation attempt ${attempt} failed:`, err);
    }
  }

  // Safe fallback if all AI attempts fail
  return heuristicGenerateEmail(input, attempt);
}
