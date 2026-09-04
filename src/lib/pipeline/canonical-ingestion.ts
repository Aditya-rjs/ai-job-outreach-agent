import { normalizeEmail, isValidEmail } from '@/lib/utils';
import { normalizeCompanyName, formatCompanyDisplayName } from '@/lib/utils/company';
import type { NormalizedContactRecord } from '@/lib/parsers/field-mapper';

export interface CanonicalContact {
  sourceRow: number;
  companyName: string;          // Reconstructed & context-inherited company name
  rawCompanyName: string;       // Original raw company name from row
  companyInherited: boolean;    // True if forward-filled from preceding row context
  companyDiagnostic?: string;   // Diagnostic rationale if genuinely Unknown Company
  normalizedCompany: string;    // Normalized for company-level AI classification & caching
  contactName: string;
  rawEmail: string;
  email: string;                // Normalized (trimmed, lowercase)
  emailValid: boolean;
  designation?: string;
  companyWebsite?: string;
  companyLocation?: string;
}

/**
 * Checks if a company field is empty, blank, or a continuation marker.
 * Supports: empty string, whitespace, null, undefined, ditto marks (", ''),
 * and common placeholder markers (-, --, n/a, na, do, -do-).
 */
export function isBlankOrContinuationCompany(val: string | null | undefined): boolean {
  if (val === null || val === undefined) return true;
  const trimmed = val.trim();
  if (trimmed.length === 0) return true;

  const lower = trimmed.toLowerCase();
  // Check for ditto marks or continuation indicators commonly used in tabular data
  if (
    trimmed === '"' ||
    trimmed === '""' ||
    trimmed === "''" ||
    trimmed === '“' ||
    trimmed === '”' ||
    trimmed === '-' ||
    trimmed === '--' ||
    trimmed === '—' ||
    trimmed === '.' ||
    lower === 'do' ||
    lower === '-do-' ||
    lower === 'same' ||
    lower === 'same as above' ||
    lower === 'unknown' ||
    lower === 'unknown company' ||
    lower === 'n/a' ||
    lower === 'na'
  ) {
    return true;
  }

  return false;
}

/**
 * Reconstructs raw tabular rows into canonical contact records with:
 * 1. Forward-filling company context across merged/continuation rows
 * 2. Strict company isolation (new valid company immediately replaces active context)
 * 3. Never using "Unknown Company" when a valid preceding company exists
 * 4. Capturing diagnostic reasons if a company genuinely cannot be determined
 * 5. Full field normalization (emails, company display, contact names)
 *
 * Every file format (CSV, XLSX, PDF, OCR) passes through this same canonical pipeline.
 */
export function reconstructCanonicalContacts(
  rawRecords: (NormalizedContactRecord | Record<string, unknown>)[]
): CanonicalContact[] {
  const canonicalContacts: CanonicalContact[] = [];
  let activeCompanyContext = '';

  for (let i = 0; i < rawRecords.length; i++) {
    const raw = rawRecords[i];
    const sourceRow = i + 1;

    const rawCompanyStr = typeof raw.companyName === 'string' ? raw.companyName.trim() : '';
    const rawContactName = typeof raw.contactName === 'string' ? raw.contactName.trim() : '';
    const rawEmail = typeof raw.email === 'string' ? raw.email.trim() : '';
    const rawDesignation = typeof raw.designation === 'string' ? raw.designation.trim() : undefined;
    const rawWebsite = typeof raw.companyWebsite === 'string' ? raw.companyWebsite.trim() : undefined;
    const rawLocation = typeof raw.companyLocation === 'string' ? raw.companyLocation.trim() : undefined;

    // Skip entirely empty spacer rows (no company, no contact name, no email)
    if (!rawCompanyStr && !rawContactName && !rawEmail && !rawDesignation) {
      continue;
    }

    let finalCompany = '';
    let isInherited = false;
    let diagnostic: string | undefined;

    if (!isBlankOrContinuationCompany(rawCompanyStr)) {
      // Valid new company encountered — establishes new company context
      activeCompanyContext = rawCompanyStr;
      finalCompany = rawCompanyStr;
      isInherited = false;
    } else {
      // Empty, blank, or continuation cell — inherit active company context if available
      if (activeCompanyContext) {
        finalCompany = activeCompanyContext;
        isInherited = true;
      } else {
        // Genuinely missing company context (e.g. top of file without header or preceding row)
        finalCompany = 'Unknown Company';
        isInherited = false;
        diagnostic = 'No preceding company header or context found in table.';
      }
    }

    const normalizedEmailStr = normalizeEmail(rawEmail);
    const emailValid = Boolean(rawEmail && isValidEmail(normalizedEmailStr));

    canonicalContacts.push({
      sourceRow,
      companyName: formatCompanyDisplayName(finalCompany),
      rawCompanyName: rawCompanyStr,
      companyInherited: isInherited,
      companyDiagnostic: diagnostic,
      normalizedCompany: normalizeCompanyName(finalCompany),
      contactName: rawContactName,
      rawEmail,
      email: normalizedEmailStr,
      emailValid,
      designation: rawDesignation || undefined,
      companyWebsite: rawWebsite || undefined,
      companyLocation: rawLocation || undefined,
    });
  }

  return canonicalContacts;
}
