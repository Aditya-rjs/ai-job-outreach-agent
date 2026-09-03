/**
 * Normalizes a company name for deduplication and classification caching.
 * Example: "  Google, LLC  " -> "google"
 * Example: "Microsoft Corporation" -> "microsoft"
 */
export function normalizeCompanyName(name: string | null | undefined): string {
  if (!name) return '';
  
  let normalized = name.trim().toLowerCase();

  // Remove common legal/business suffixes and punctuation
  normalized = normalized
    .replace(/[,\.\-\/\\_]/g, ' ') // replace punctuation with spaces
    .replace(/\s+/g, ' ') // collapse multiple spaces
    .trim();

  // Strip corporate suffixes for cache keying
  const suffixes = [
    'pvt ltd',
    'private limited',
    'ltd',
    'limited',
    'llc',
    'inc',
    'incorporated',
    'corp',
    'corporation',
    'co',
    'company',
    'gmbh',
    'technologies',
    'technology',
    'services',
    'solutions',
  ];

  for (const suffix of suffixes) {
    const regex = new RegExp(`\\b${suffix}\\b$`, 'i');
    normalized = normalized.replace(regex, '').trim();
  }

  return normalized || name.trim().toLowerCase();
}

/**
 * Formats a company name for clean display.
 */
export function formatCompanyDisplayName(name: string | null | undefined): string {
  if (!name) return 'Unknown Company';
  const trimmed = name.trim();
  return trimmed.replace(/\s+/g, ' ');
}
