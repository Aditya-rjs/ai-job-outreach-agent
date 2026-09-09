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

  // Row 0 is treated as the column header row
  const rawHeaders = (rawRows[0] || []).map((h) => (h !== undefined && h !== null ? String(h).trim() : ''));
  const headers = rawHeaders.map((h, i) => h || `Column_${i + 1}`);

  const rows: Record<string, string>[] = [];

  for (let i = 1; i < rawRows.length; i++) {
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

  const mapping = await getFieldMapping(headers);
  return applyFieldMapping(rows, mapping);
}
