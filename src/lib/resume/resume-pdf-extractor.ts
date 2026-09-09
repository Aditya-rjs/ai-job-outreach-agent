/**
 * Dedicated high-fidelity PDF text extraction utility for candidate resume documents.
 * Preserves horizontal spacing between table columns and dates, preserves bullet points,
 * and normalizes formatting artifacts while leaving factual text intact.
 */

interface TextItem {
  str: string;
  dir: string;
  width: number;
  height: number;
  transform: number[];
  fontName: string;
}

interface PageData {
  getTextContent: (options: {
    normalizeWhitespace: boolean;
    disableCombineTextItems: boolean;
  }) => Promise<{ items: TextItem[] }>;
}

/**
 * Custom PDF.js page renderer for pdf-parse.
 * Tracks X/Y coordinates to prevent horizontal word merging (e.g. table columns, dates touching company names)
 * and correctly detects vertical line jumps.
 */
function renderPageWithCoordinates(pageData: PageData): Promise<string> {
  return pageData
    .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
    .then((textContent) => {
      let lastY: number | null = null;
      let lastX: number | null = null;
      let lastWidth = 0;
      let text = '';

      for (const item of textContent.items) {
        const currentX = item.transform[4];
        const currentY = item.transform[5];
        const str = item.str;

        if (lastY === null) {
          text += str;
        } else if (Math.abs(lastY - currentY) > 3) {
          // Significant vertical jump indicates a new line
          text += '\n' + str;
        } else {
          // Same horizontal line: check if space should be inserted between distinct tokens
          const gap = currentX - (lastX! + lastWidth);
          const alreadySpaced = text.endsWith(' ') || str.startsWith(' ') || text.endsWith('\n');
          const needsSpace = !alreadySpaced && (gap > 1.5 || gap < -1.5);

          text += (needsSpace ? ' ' : '') + str;
        }

        lastY = currentY;
        lastX = currentX;
        lastWidth = item.width || 0;
      }

      return text;
    });
}

/**
 * Normalizes raw extracted PDF text:
 * - Unifies line breaks (\r\n -> \n)
 * - Normalizes Unicode non-breaking and zero-width spaces
 * - Standardizes bullet glyphs (•, –, -, *)
 * - Cleans isolated font icon artifacts (e.g. mojibake glyphs alone on lines)
 * - Collapses excessive blank lines
 */
export function normalizeExtractedPdfText(text: string): string {
  if (!text) return '';

  return (
    text
      // Unify newlines
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // Non-breaking and zero-width spaces
      .replace(/[\u00A0\u1680\u180E\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')
      // Standardize bullet points to bullet character, including Wingdings / Symbol mojibake (ï‚·, \uF0B7, etc.)
      .replace(/^[ \t]*(?:ï‚·|\uF0B7|\uF0A7|\uF0A8|[\u2022\u2023\u25E6\u2043\u2219])[ \t]*/gm, '• ')
      .replace(/ï‚·/g, '•')
      .replace(/^[ \t]*[\u2013\u2014][ \t]*/gm, '– ')
      // Clean isolated single-character icon mojibake glyphs that appear alone on lines
      .replace(/\n[ï§€H#]\n/g, '\n')
      // Remove trailing whitespace per line
      .replace(/[ \t]+$/gm, '')
      // Collapse 3+ consecutive newlines to at most 2
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Primary entry point for extracting text from a candidate's resume PDF buffer.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    const parse = typeof pdfParse === 'function' ? pdfParse : pdfParse.default;

    // Convert Buffer to an isolated Uint8Array with zero byteOffset to prevent PDF.js
    // from reading adjacent memory in Node's pooled ArrayBuffers.
    const uint8Array = new Uint8Array(buffer);

    const data = await parse(uint8Array, {
      pagerender: renderPageWithCoordinates,
    });

    const raw = data.text || '';
    return normalizeExtractedPdfText(raw);
  } catch (err) {
    console.warn('[ResumePdfExtractor] Direct PDF text extraction error, falling back to default renderer:', err);
    try {
      // Secondary fallback to standard parser if custom renderer encounters unsupported PDF construct
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require('pdf-parse/lib/pdf-parse.js');
      const parse = typeof pdfParse === 'function' ? pdfParse : pdfParse.default;
      const data = await parse(new Uint8Array(buffer));
      return normalizeExtractedPdfText(data.text || '');
    } catch (fallbackErr) {
      console.warn('[ResumePdfExtractor] Fallback extraction failed:', fallbackErr);
      return '';
    }
  }
}
