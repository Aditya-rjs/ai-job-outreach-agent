import { parse } from 'csv-parse/sync';

export interface ParsedCSV {
  headers: string[];
  rows: Record<string, string>[];
}

/**
 * Detects common delimiters (, ; \t |) from the first few non-empty lines of CSV text.
 */
function detectDelimiter(content: string): string {
  const sample = content.slice(0, 4096);
  const lines = sample.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return ',';

  const counts: Record<string, number> = {
    ',': 0,
    ';': 0,
    '\t': 0,
    '|': 0,
  };

  // Sample the first few non-empty lines (up to 5) so banner rows without delimiters do not skew detection
  const sampleLines = lines.slice(0, 5);
  for (const line of sampleLines) {
    counts[','] += (line.match(/,/g) || []).length;
    counts[';'] += (line.match(/;/g) || []).length;
    counts['\t'] += (line.match(/\t/g) || []).length;
    counts['|'] += (line.match(/\|/g) || []).length;
  }

  let maxCount = 0;
  let bestDelimiter = ',';

  for (const [delim, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      bestDelimiter = delim;
    }
  }

  return bestDelimiter;
}

/**
 * Parses a CSV string or buffer into headers and row objects.
 */
export function parseCSV(input: Buffer | string): ParsedCSV {
  let text = typeof input === 'string' ? input : input.toString('utf-8');

  // Strip Byte Order Mark (BOM) if present
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const delimiter = detectDelimiter(text);

  const rawRecords = parse(text, {
    delimiter,
    columns: false,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    trim: true,
  }) as string[][];

  if (!rawRecords || rawRecords.length === 0) {
    return { headers: [], rows: [] };
  }

  // Find the actual header row:
  // Detect leading title/banner row(s) before the actual header.
  // If the first row contains only one populated cell and a subsequent row
  // contains multiple meaningful column headers (>= 2 populated cells),
  // treat the subsequent multi-column row as the actual header.
  let headerRowIndex = 0;
  const scanLimit = Math.min(10, rawRecords.length);

  let maxColCount = 0;
  for (let i = 0; i < scanLimit; i++) {
    const populated = rawRecords[i].filter((c) => c && String(c).trim().length > 0).length;
    if (populated > maxColCount) {
      maxColCount = populated;
    }
  }

  if (maxColCount >= 2) {
    for (let i = 0; i < scanLimit; i++) {
      const populated = rawRecords[i].filter((c) => c && String(c).trim().length > 0).length;
      if (populated >= 2) {
        headerRowIndex = i;
        break;
      }
    }
  }

  // Header row is taken from the detected headerRowIndex
  const rawHeaders = (rawRecords[headerRowIndex] || []).map((h) =>
    h !== undefined && h !== null ? String(h).trim() : ''
  );
  
  // Normalize header names to avoid duplicate keys or empty headers
  const headers = rawHeaders.map((h, i) => h || `Column_${i + 1}`);
  while (headers.length < maxColCount) {
    headers.push(`Column_${headers.length + 1}`);
  }

  const rows: Record<string, string>[] = [];

  for (let i = headerRowIndex + 1; i < rawRecords.length; i++) {
    const rowValues = rawRecords[i] || [];
    
    // Check if the entire row is empty
    const isEmpty = rowValues.every((val) => !val || String(val).trim().length === 0);
    if (isEmpty) continue;

    const rowObj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      const headerName = headers[j];
      const val = rowValues[j] !== undefined && rowValues[j] !== null ? String(rowValues[j]).trim() : '';
      rowObj[headerName] = val;
    }
    rows.push(rowObj);
  }

  return { headers, rows };
}
