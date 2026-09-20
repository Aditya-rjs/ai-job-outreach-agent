import * as XLSX from 'xlsx';
import { getFieldMapping, applyFieldMapping, type NormalizedContactRecord } from './field-mapper';

export interface ParsedExcel {
  headers: string[];
  rows: Record<string, string>[];
}

/**
 * Parses an Excel (.xlsx) buffer into structured headers and rows.
 * Reads the first worksheet as the primary contacts table.
 * Preserves cell formats, trims whitespace, and skips empty rows.
 */
export function parseExcelWorkbook(buffer: Buffer): ParsedExcel {
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    cellFormula: false,
    cellHTML: false,
    raw: false, // Return formatted strings for dates, phone numbers, and numbers
  });

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    return { headers: [], rows: [] };
  }

  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];

  if (!worksheet) {
    return { headers: [], rows: [] };
  }

  // Convert worksheet to 2D array of strings with empty cells preserved as empty strings
  const rawRows = XLSX.utils.sheet_to_json<string[]>(worksheet, {
    header: 1,
    defval: '',
    blankrows: false,
  });

  if (!rawRows || rawRows.length === 0) {
    return { headers: [], rows: [] };
  }

  // Detect leading title/banner row(s) before the actual header.
  // If the first row contains only one populated cell and a subsequent row
  // contains multiple column headers (>= 2 populated cells),
  // treat the subsequent multi-column row as the actual header.
  let headerRowIndex = 0;
  const scanLimit = Math.min(10, rawRows.length);

  let maxColCount = 0;
  for (let i = 0; i < scanLimit; i++) {
    const populated = (rawRows[i] || []).filter(
      (c) => c !== undefined && c !== null && String(c).trim().length > 0
    ).length;
    if (populated > maxColCount) {
      maxColCount = populated;
    }
  }

  if (maxColCount >= 2) {
    for (let i = 0; i < scanLimit; i++) {
      const populated = (rawRows[i] || []).filter(
        (c) => c !== undefined && c !== null && String(c).trim().length > 0
      ).length;
      if (populated >= 2) {
        headerRowIndex = i;
        break;
      }
    }
  }

  const rawHeaders = (rawRows[headerRowIndex] || []).map((h) =>
    h !== undefined && h !== null ? String(h).trim() : ''
  );
  const headers = rawHeaders.map((h, i) => h || `Column_${i + 1}`);
  while (headers.length < maxColCount) {
    headers.push(`Column_${headers.length + 1}`);
  }

  const rows: Record<string, string>[] = [];

  for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
    const rowValues = rawRows[i] || [];

    // Skip entirely empty rows
    const isRowEmpty = rowValues.every((val) => !val || String(val).trim().length === 0);
    if (isRowEmpty) continue;

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

/**
 * Main entry point for parsing Excel files into NormalizedContactRecords.
 * Reuses the existing deterministic field mapper and mapping dictionary.
 */
export async function parseExcel(buffer: Buffer): Promise<NormalizedContactRecord[]> {
  const { headers, rows } = parseExcelWorkbook(buffer);

  if (rows.length === 0 || headers.length === 0) {
    return [];
  }

  const mapping = await getFieldMapping(headers, rows.slice(0, 20));
  return applyFieldMapping(rows, mapping);
}
