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

  const firstLine = lines[0];
  const counts: Record<string, number> = {
    ',': (firstLine.match(/,/g) || []).length,
    ';': (firstLine.match(/;/g) || []).length,
    '\t': (firstLine.match(/\t/g) || []).length,
    '|': (firstLine.match(/\|/g) || []).length,
  };

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

  // First non-empty row is treated as the header row
  const rawHeaders = rawRecords[0].map((h) => h.trim());
  
  // Normalize header names to avoid duplicate keys or empty headers
  const headers = rawHeaders.map((h, i) => h || `Column_${i + 1}`);

  const rows: Record<string, string>[] = [];

  for (let i = 1; i < rawRecords.length; i++) {
    const rowValues = rawRecords[i];
    
    // Check if the entire row is empty
    const isEmpty = rowValues.every((val) => !val || val.trim().length === 0);
    if (isEmpty) continue;

    const rowObj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      const headerName = headers[j];
      const val = rowValues[j] !== undefined ? String(rowValues[j]).trim() : '';
      rowObj[headerName] = val;
    }
    rows.push(rowObj);
  }

  return { headers, rows };
}
