import { callGemini, getGeminiClient } from '@/lib/ai/gemini-client';

export type NormalizedField =
  | 'company_name'
  | 'contact_name'
  | 'email'
  | 'designation'
  | 'company_website'
  | 'company_location'
  | 'IGNORE';

export interface FieldMapping {
  [rawHeader: string]: NormalizedField;
}

export interface NormalizedContactRecord {
  companyName: string;
  contactName: string;
  email: string;
  designation?: string;
  companyWebsite?: string;
  companyLocation?: string;
}

const DETERMINISTIC_MAP: Record<string, NormalizedField> = {
  // Company
  company: 'company_name',
  'company name': 'company_name',
  'company_name': 'company_name',
  organization: 'company_name',
  organisation: 'company_name',
  'org name': 'company_name',
  employer: 'company_name',
  firm: 'company_name',
  business: 'company_name',
  client: 'company_name',

  // Contact / HR
  'hr name': 'contact_name',
  hr: 'contact_name',
  'hr_name': 'contact_name',
  recruiter: 'contact_name',
  'recruiter name': 'contact_name',
  'recruiter_name': 'contact_name',
  'contact person': 'contact_name',
  'contact_person': 'contact_name',
  'contact name': 'contact_name',
  contact: 'contact_name',
  'hr contact': 'contact_name',
  name: 'contact_name',
  'full name': 'contact_name',
  'hiring manager': 'contact_name',
  'talent acquisition': 'contact_name',
  'point of contact': 'contact_name',
  poc: 'contact_name',

  // Email
  email: 'email',
  'email address': 'email',
  'email_address': 'email',
  'hr email': 'email',
  'hr_email': 'email',
  'recruiter email': 'email',
  'recruiter_email': 'email',
  'contact email': 'email',
  'contact_email': 'email',
  'e-mail': 'email',
  'email id': 'email',
  'email_id': 'email',
  'work email': 'email',
  'official email': 'email',
  mail: 'email',

  // Designation
  designation: 'designation',
  title: 'designation',
  'job title': 'designation',
  'job_title': 'designation',
  role: 'designation',
  position: 'designation',

  // Website
  website: 'company_website',
  'company website': 'company_website',
  'company_website': 'company_website',
  url: 'company_website',
  web: 'company_website',
  domain: 'company_website',

  // Location
  location: 'company_location',
  address: 'company_location',
  city: 'company_location',
  headquarters: 'company_location',
  hq: 'company_location',
  country: 'company_location',
  state: 'company_location',

  // Common IGNORED fields
  phone: 'IGNORE',
  'phone number': 'IGNORE',
  'mobile': 'IGNORE',
  'mobile number': 'IGNORE',
  'contact number': 'IGNORE',
  'tel': 'IGNORE',
  salary: 'IGNORE',
  stipend: 'IGNORE',
  ctc: 'IGNORE',
  notes: 'IGNORE',
  remarks: 'IGNORE',
  status: 'IGNORE',
  id: 'IGNORE',
  's.no': 'IGNORE',
  'sr no': 'IGNORE',
  'serial number': 'IGNORE',
};

/**
 * Attempts deterministic field mapping for headers.
 */
export function mapHeadersDeterministically(headers: string[]): FieldMapping {
  const mapping: FieldMapping = {};

  for (const header of headers) {
    const clean = header.trim().toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');
    if (DETERMINISTIC_MAP[clean]) {
      mapping[header] = DETERMINISTIC_MAP[clean];
    } else {
      // Check partial matches
      if (clean.includes('email') || clean.includes('e-mail')) {
        mapping[header] = 'email';
      } else if (clean.includes('company') || clean.includes('organization') || clean.includes('employer')) {
        mapping[header] = 'company_name';
      } else if (clean.includes('recruiter') || clean.includes('hr') || clean.includes('contact') || clean.includes('name')) {
        mapping[header] = 'contact_name';
      } else if (clean.includes('website') || clean.includes('domain') || clean.includes('url')) {
        mapping[header] = 'company_website';
      } else if (clean.includes('location') || clean.includes('city') || clean.includes('address')) {
        mapping[header] = 'company_location';
      } else if (clean.includes('phone') || clean.includes('mobile') || clean.includes('number') || clean.includes('salary')) {
        mapping[header] = 'IGNORE';
      } else {
        mapping[header] = 'IGNORE';
      }
    }
  }

  return mapping;
}

/**
 * Uses Gemini to map ambiguous column headers.
 */
export async function mapHeadersWithAI(headers: string[]): Promise<FieldMapping> {
  const prompt = `You are an expert data engineer. Map the following CSV/spreadsheet column headers into our normalized fields.

Target fields allowed:
- "company_name": Name of the company, organization, or employer
- "contact_name": Name of the HR, recruiter, contact person, or hiring manager
- "email": Email address of the recruiter or contact
- "designation": Job title or role of the contact person
- "company_website": Official website or domain of the company
- "company_location": Location, city, state, or address of the company
- "IGNORE": Any other field (phone number, serial number, notes, salary, etc.)

Input column headers:
${JSON.stringify(headers, null, 2)}

Respond ONLY with a valid JSON object where keys are the EXACT input headers and values are one of the allowed target fields above. Do not include markdown code blocks or extra text.`;

  try {
    const responseText = await callGemini(prompt, { temperature: 0.1 });
    const cleaned = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    const validTargets: Set<string> = new Set([
      'company_name',
      'contact_name',
      'email',
      'designation',
      'company_website',
      'company_location',
      'IGNORE',
    ]);

    const result: FieldMapping = {};
    for (const h of headers) {
      const val = parsed[h];
      if (typeof val === 'string' && validTargets.has(val)) {
        result[h] = val as NormalizedField;
      } else {
        result[h] = 'IGNORE';
      }
    }

    return result;
  } catch (err) {
    console.warn('AI field mapping failed, falling back to deterministic mapping:', err);
    return mapHeadersDeterministically(headers);
  }
}

/**
 * Maps headers to normalized fields. Uses deterministic mapping first.
 * If critical fields (email, company_name) are missing or ambiguous, and Gemini is available, uses AI.
 */
export async function getFieldMapping(headers: string[]): Promise<FieldMapping> {
  const deterministic = mapHeadersDeterministically(headers);

  const mappedValues = Object.values(deterministic);
  const hasEmail = mappedValues.includes('email');
  const hasCompany = mappedValues.includes('company_name');

  // If deterministic mapping successfully identified both email and company, use it directly!
  if (hasEmail && hasCompany) {
    return deterministic;
  }

  // If Gemini is configured and we're missing core fields, attempt AI mapping
  if (getGeminiClient()) {
    try {
      const aiMapping = await mapHeadersWithAI(headers);
      const aiValues = Object.values(aiMapping);
      if (aiValues.includes('email') || aiValues.includes('company_name')) {
        return aiMapping;
      }
    } catch {
      // fallback to deterministic
    }
  }

  return deterministic;
}

/**
 * Transforms raw row records into normalized contact records based on the field mapping.
 */
export function applyFieldMapping(
  rows: Record<string, string>[],
  mapping: FieldMapping
): NormalizedContactRecord[] {
  const normalized: NormalizedContactRecord[] = [];

  for (const row of rows) {
    let companyName = '';
    let contactName = '';
    let email = '';
    let designation: string | undefined;
    let companyWebsite: string | undefined;
    let companyLocation: string | undefined;

    for (const [header, val] of Object.entries(row)) {
      const target = mapping[header];
      const trimmedVal = (val || '').trim();
      if (!trimmedVal) continue;

      switch (target) {
        case 'company_name':
          if (!companyName) companyName = trimmedVal;
          break;
        case 'contact_name':
          if (!contactName) contactName = trimmedVal;
          break;
        case 'email':
          if (!email) email = trimmedVal;
          break;
        case 'designation':
          if (!designation) designation = trimmedVal;
          break;
        case 'company_website':
          if (!companyWebsite) companyWebsite = trimmedVal;
          break;
        case 'company_location':
          if (!companyLocation) companyLocation = trimmedVal;
          break;
      }
    }

    normalized.push({
      companyName,
      contactName,
      email,
      designation,
      companyWebsite,
      companyLocation,
    });
  }

  return normalized;
}
