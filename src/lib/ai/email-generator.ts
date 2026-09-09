import { callGemini, getGeminiClient, GEMINI_PRIORITIES, categorizeGeminiError } from './gemini-client';
import { callAi } from './ai-dispatcher';
import { isOpenRouterConfigured } from './openrouter-client';
import { checkEmailSimilarity } from './similarity';
import {
  extractAndParseEmailJson,
  AiOutputInvalidError,
  isAiOutputInvalidError,
  type ParsedEmailOutput,
} from './json-parser';
import type { StructuredResumeProfile, GeneratedEmailResult, VerifiedProfileLinks } from '@/types';

export { AiOutputInvalidError, isAiOutputInvalidError, extractAndParseEmailJson, type ParsedEmailOutput };

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
  isRetry?: boolean;
  strictGemini?: boolean;
  verifiedLinks?: VerifiedProfileLinks;
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
 * Heuristic email generation fallback when AI API is unavailable.
 * Generates natural variations based on strategy to prevent mass-template duplication.
 */
function heuristicGenerateEmail(
  input: EmailGenerationInput,
  strategyIndex = 0
): GeneratedEmailResult {
  const { profile, companyName, contactName, designation, relevanceReason, verifiedLinks } = input;

  const candidateName = profile.name || 'Aditya Raj Singh';
  const primaryEdu = profile.education?.[0];
  const degree = primaryEdu?.degree || 'Computer Science Engineering graduate';
  const institution = primaryEdu?.institution || 'LNJPIT Chapra';
  const topLanguages = (profile.skills?.languages || []).slice(0, 3).join(', ') || 'JavaScript, TypeScript, SQL';
  const topFrameworks = (profile.skills?.frameworks || []).slice(0, 3).join(', ') || 'React, Next.js, Node.js';
  const topProject = profile.projects?.[0]?.title || 'web-based software platforms';
  const projectTech = (profile.projects?.[0]?.techStack || []).slice(0, 3).join(', ') || topFrameworks;
  const projectHighlight = profile.projects?.[0]?.highlights?.[0] || profile.projects?.[0]?.description || '';

  const greeting = contactName && contactName.trim()
    ? `Dear ${contactName.trim()},`
    : 'Hello Recruitment Team,';

  const linkLines: string[] = [];
  if (verifiedLinks?.linkedin) linkLines.push(`LinkedIn: ${verifiedLinks.linkedin}`);
  if (verifiedLinks?.github) linkLines.push(`GitHub: ${verifiedLinks.github}`);
  if (verifiedLinks?.portfolio) linkLines.push(`Portfolio: ${verifiedLinks.portfolio}`);

  const signature = [
    'Best regards,',
    candidateName,
    `${degree} — ${institution}`,
    profile.email ? `Email: ${profile.email}` : '',
    profile.phone ? `Phone: ${profile.phone}` : '',
    ...linkLines,
  ].filter(Boolean).join('\n');

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
      subject = `Exploring Fresher / Entry-Level Opportunities at ${companyName} — ${candidateName}`;
      bodyParagraphs = [
        greeting,
        `I am writing to express my sincere interest in software engineering and technical opportunities at ${companyName}. As a ${degree} from ${institution}, I have focused heavily on building production-ready systems, notably ${topProject} using ${projectTech}${projectHighlight ? ` (${projectHighlight})` : ''}.`,
        `Given ${companyName}'s engineering standards, I would welcome the opportunity to contribute my foundation across ${topLanguages} and ${topFrameworks} to your engineering team. I pride myself on writing clean, scalable code and learning new architectures rapidly.`,
        `I would be grateful if you could keep my profile in mind for any current or upcoming fresher or entry-level software openings. My resume is attached for your review, and I would welcome the opportunity to connect.`,
        signature,
      ];
      break;

    case 'company-focused':
      subject = `Exploring Fresher Opportunities at ${companyName} — ${candidateName}`;
      bodyParagraphs = [
        greeting,
        `I have been following ${companyName}'s work in technology and engineering with great admiration. I am reaching out to explore potential fresher or entry-level software engineering opportunities where I could contribute and grow.`,
        `I recently completed my ${degree} at ${institution}, developing hands-on experience across full-stack development with ${topFrameworks} as well as ${topLanguages}. Through rigorous project work such as building ${topProject}, I have developed strong problem-solving skills and a deep enthusiasm for robust software development.`,
        `If ${companyName} has any suitable entry-level openings or graduate opportunities now or in the near future, I would appreciate the chance to discuss how my background aligns with your team's goals.`,
        signature,
      ];
      break;

    case 'concise-direct':
      subject = `Exploring Entry-Level Opportunities at ${companyName} — ${candidateName}`;
      bodyParagraphs = [
        greeting,
        `I am reaching out to inquire about fresher and entry-level software engineering opportunities at ${companyName}. I am a ${degree} from ${institution} with practical experience across ${topLanguages} and ${topFrameworks}.`,
        `Recently, I developed ${topProject}, implementing scalable architecture with ${projectTech}. I am eager to bring this same dedication and technical discipline to ${companyName}'s technical initiatives.`,
        `Please find my attached resume for your consideration. I would welcome the opportunity for a brief conversation if there is an alignment with your upcoming hiring needs.`,
        signature,
      ];
      break;

    case 'technical':
      subject = `Software Engineering Opportunity Inquiry at ${companyName} — ${candidateName}`;
      bodyParagraphs = [
        greeting,
        `I am writing to inquire about entry-level software engineering opportunities at ${companyName}. With an academic background in ${degree} from ${institution}, my core technical strengths center around ${topLanguages}, alongside ${topFrameworks}.`,
        `In my recent work on ${topProject}, I focused on system architecture, database optimization, and delivering clean, maintainable user interfaces. I am excited by the engineering culture at ${companyName} and would love to contribute to your software products.`,
        `Should your team have any relevant openings or upcoming fresher opportunities, I would be thrilled to be considered. Thank you for your time and consideration.`,
        signature,
      ];
      break;

    case 'career-interest-focused':
      subject = `Exploring Fresher Opportunities at ${companyName} — ${candidateName}`;
      bodyParagraphs = [
        greeting,
        `I am writing to express my strong enthusiasm for joining ${companyName} in an entry-level software engineering capacity. With my academic background in ${degree} from ${institution}, I have prepared diligently for a career building robust, high-performance software.`,
        `My technical background includes solid hands-on development in ${topLanguages} and ${topFrameworks}. Building applications such as ${topProject} taught me how to deliver scalable solutions from database modeling to responsive frontend interfaces.`,
        `I would love the opportunity to explore any entry-level software engineer, developer, or trainee positions currently or soon to be available with your team. My resume is attached for your review.`,
        signature,
      ];
      break;

    default: // skills-focused
      subject = `Exploring Fresher Opportunities at ${companyName} — ${candidateName}`;
      bodyParagraphs = [
        greeting,
        `I hope this email finds you well. I am reaching out to express my keen interest in fresher and entry-level software engineering opportunities with ${companyName}.`,
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
  const { profile, companyName, contactName, designation, companyWebsite, companyLocation, relevanceReason, verifiedLinks } = input;

  // Build structured candidate facts dossier
  const eduLines = (profile.education || []).map((e) => {
    const parts = [`${e.degree} from ${e.institution}`];
    if (e.year) parts.push(`(${e.year})`);
    if (e.score) parts.push(`[Grade/Score: ${e.score}]`);
    return `- ${parts.join(' ')}`;
  }).join('\n');

  const skillsCategories: string[] = [];
  if (profile.skills?.languages?.length) skillsCategories.push(`- Languages: ${profile.skills.languages.join(', ')}`);
  if (profile.skills?.frameworks?.length) skillsCategories.push(`- Frameworks & Libraries: ${profile.skills.frameworks.join(', ')}`);
  if (profile.skills?.webTechnologies?.length) skillsCategories.push(`- Web Technologies: ${profile.skills.webTechnologies.join(', ')}`);
  if (profile.skills?.backendTechnologies?.length) skillsCategories.push(`- Backend: ${profile.skills.backendTechnologies.join(', ')}`);
  if (profile.skills?.databases?.length) skillsCategories.push(`- Databases: ${profile.skills.databases.join(', ')}`);
  if (profile.skills?.cloudDevOps?.length) skillsCategories.push(`- Cloud & DevOps: ${profile.skills.cloudDevOps.join(', ')}`);
  if (profile.skills?.aiMl?.length) skillsCategories.push(`- AI & Machine Learning: ${profile.skills.aiMl.join(', ')}`);
  if (profile.skills?.developerTools?.length) skillsCategories.push(`- Developer Tools: ${profile.skills.developerTools.join(', ')}`);
  if (profile.skills?.coreConcepts?.length) skillsCategories.push(`- Core Concepts: ${profile.skills.coreConcepts.join(', ')}`);
  if (profile.skills?.other?.length) skillsCategories.push(`- Other Skills: ${profile.skills.other.join(', ')}`);

  const experienceLines = (profile.experience || []).map((exp) => {
    const header = `- ${exp.title} at ${exp.company} (${exp.startDate || ''} – ${exp.endDate || 'Present'}${exp.location ? `, ${exp.location}` : ''})`;
    const bullets = (exp.bullets || []).map((b) => `  * ${b}`).join('\n');
    const tools = exp.technologies?.length ? `  * Tech/Tools: ${exp.technologies.join(', ')}` : '';
    return [header, bullets, tools].filter(Boolean).join('\n');
  }).join('\n\n');

  const projectLines = (profile.projects || []).map((p) => {
    const header = `- ${p.title}${p.techStack?.length ? ` [Tech: ${p.techStack.join(', ')}]` : ''}`;
    const desc = p.description ? `  * Summary: ${p.description}` : '';
    const highlights = (p.highlights || []).map((h) => `  * ${h}`).join('\n');
    const metrics = (p.metrics || []).map((m) => `  * Metric: ${m}`).join('\n');
    const links = [
      p.liveUrl ? `Live: ${p.liveUrl}` : '',
      p.githubUrl ? `GitHub: ${p.githubUrl}` : '',
    ].filter(Boolean).join(' | ');
    const linkLine = links ? `  * Project Links: ${links}` : '';
    return [header, desc, highlights, metrics, linkLine].filter(Boolean).join('\n');
  }).join('\n\n');

  const achievementLines = (profile.achievements || []).map((ach) => {
    if (typeof ach === 'string') return `- ${ach}`;
    return `- ${ach.title}${ach.description ? `: ${ach.description}` : ''}${ach.year ? ` (${ach.year})` : ''}`;
  }).join('\n');

  const certLines = (profile.certifications || []).map((cert) => {
    if (typeof cert === 'string') return `- ${cert}`;
    return `- ${cert.name}${cert.issuer ? ` (Issued by ${cert.issuer})` : ''}${cert.year ? ` [${cert.year}]` : ''}`;
  }).join('\n');

  const leadershipLines = (profile.leadership || []).map((lead) => {
    return `- ${lead.role}${lead.organization ? ` at ${lead.organization}` : ''}${lead.period ? ` (${lead.period})` : ''}${lead.description ? `: ${lead.description}` : ''}`;
  }).join('\n');

  const verifiedLinkLines: string[] = [];
  if (verifiedLinks?.linkedin) verifiedLinkLines.push(`- LinkedIn: ${verifiedLinks.linkedin}`);
  if (verifiedLinks?.github) verifiedLinkLines.push(`- GitHub: ${verifiedLinks.github}`);
  if (verifiedLinks?.portfolio) verifiedLinkLines.push(`- Portfolio: ${verifiedLinks.portfolio}`);
  if (verifiedLinks?.other) verifiedLinkLines.push(`- Other: ${verifiedLinks.other}`);

  return `You are a professional career communication specialist writing a personalized, high-conviction job-outreach email from an engineering candidate to an HR recruiter or hiring manager.

=== CANDIDATE FACTS (STRICT SOURCE OF TRUTH — NO HALLUCINATIONS) ===
- Name: ${profile.name}
${profile.email ? `- Email: ${profile.email}` : ''}
${profile.phone ? `- Phone: ${profile.phone}` : ''}
${profile.summary ? `- Background Summary: ${profile.summary}` : ''}

Education:
${eduLines || '- Computer Science Engineering graduate'}

Technical Skills:
${skillsCategories.join('\n') || '- Software Engineering, Full-Stack Development'}

${experienceLines ? `Experience:\n${experienceLines}\n` : ''}${projectLines ? `Projects:\n${projectLines}\n` : ''}${achievementLines ? `Achievements:\n${achievementLines}\n` : ''}${certLines ? `Certifications:\n${certLines}\n` : ''}${leadershipLines ? `Leadership & Extra-Curricular:\n${leadershipLines}\n` : ''}
${verifiedLinkLines.length > 0 ? `Candidate's User-Verified Links (ONLY use these exact URLs if referencing links in the email body or signature):\n${verifiedLinkLines.join('\n')}` : ''}

=== RECIPIENT & COMPANY CONTEXT ===
- Company: ${companyName}
${companyWebsite ? `- Website: ${companyWebsite}` : ''}
${companyLocation ? `- Location: ${companyLocation}` : ''}
- Recipient Name: ${contactName && contactName.trim() ? contactName.trim() : 'NOT PROVIDED (use a generic professional greeting like "Hello Hiring Team," or "Hello Recruitment Team,")'}
${designation ? `- Recipient Designation: ${designation}` : ''}
${relevanceReason ? `- Verified Relevance Context: ${relevanceReason}` : ''}

=== STRATEGY FOR THIS EMAIL ===
Strategy: "${strategy}"

=== CRITICAL OUTREACH RULES & PHILOSOPHY ===
1. GENERAL FRESHER / ENTRY-LEVEL INQUIRY:
   - This email is a natural inquiry from a fresher/entry-level candidate exploring suitable fresher, graduate trainee, or entry-level software opportunities at ${companyName}.
   - Inquire politely whether the team has any current or upcoming openings suited to the candidate's background.
   - DO NOT pigeonhole the candidate into a rigid specific job opening (do NOT say "I am applying specifically for a Frontend Engineer role" or "I am applying for a Machine Learning Engineer role" unless naturally referring to projects).
   - Present the candidate's technical breadth and depth naturally.
2. SUBJECT LINE CONVENTIONS:
   - Use natural inquiry subjects such as:
     * "Exploring Fresher Opportunities at ${companyName} — ${profile.name}"
     * "Exploring Entry-Level Opportunities at ${companyName} — ${profile.name}"
     * "Software Engineering Opportunity Inquiry — ${profile.name}"
     * Or strategy-aligned variations mentioning ${companyName} and ${profile.name}.
3. STRICT ANTI-HALLUCINATION:
   - Mention ONLY skills, projects, achievements, experiences, and educational credentials present in the CANDIDATE FACTS above.
   - NEVER invent skills, certifications, unmentioned awards, metrics, or previous companies.
   - If URLs/links are included, use ONLY the exact User-Verified Links provided above. NEVER fabricate GitHub or LinkedIn handles.
4. COMPANY CONTEXT:
   - Reference ${companyName} naturally and respectfully.
   - DO NOT invent fake company news, fake mutual connections, or claim inside knowledge of private job requisitions.
5. LENGTH & TONE:
   - 100 to 180 words. Punchy, humble yet confident, professional, and direct.
   - Do NOT beg, apologize for reaching out, or sound like a mass marketing mailer.
   - Avoid cliché openings like "I hope this email finds you well" if possible; open naturally according to the strategy.
6. SIGNATURE:
   - Close with a professional sign-off with the candidate's name, degree/institution, and verified links if available.
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

  if (!getGeminiClient() && !isOpenRouterConfigured()) {
    // If neither AI API is configured, generate via diversified heuristic engine
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
      const priority = input.isRetry
        ? GEMINI_PRIORITIES.GENERATION_RETRY
        : GEMINI_PRIORITIES.EMAIL_GENERATION;

      const aiRes = await callAi(prompt, {
        temperature: 0.3 + attempt * 0.1,
        priority,
        taskName: `email-gen-${input.companyName}`,
      });
      const responseText = aiRes.text;
      const parsed = extractAndParseEmailJson(responseText, { provider: aiRes.provider });

      const generatedResult: GeneratedEmailResult = {
        subject: parsed.subject,
        body: parsed.body,
        strategy: parsed.strategy || currentStrategy,
        personalization_points:
          parsed.personalization_points && parsed.personalization_points.length > 0
            ? parsed.personalization_points
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
          console.log(
            `Generated email was ${(maxSimilarity * 100).toFixed(1)}% similar to recent emails. Regenerating with different strategy...`
          );
          avoidGuidance =
            'The previous draft was structurally too similar to another email. Vary the sentence structure, paragraph order, and opening phrasing significantly.';
          continue;
        }
      }

      return generatedResult;
    } catch (err) {
      console.warn(`AI email generation attempt ${attempt} failed:`, err);
      if (input.strictGemini) {
        throw err;
      }
    }
  }

  if (input.strictGemini) {
    throw new Error(`Failed to generate email for ${input.companyName} via AI after ${maxAttempts} attempts.`);
  }

  // Safe fallback if all AI attempts fail and not strictGemini
  return heuristicGenerateEmail(input, attempt);
}

