/**
 * Dedicated PDF text extraction utility for candidate resume documents.
 * Preserves resume parsing capabilities independently of contact list ingestion formats.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    const parse = typeof pdfParse === 'function' ? pdfParse : pdfParse.default;

    // Convert Buffer to an isolated Uint8Array with zero byteOffset to prevent PDF.js
    // from reading adjacent memory in Node's pooled ArrayBuffers.
    const uint8Array = new Uint8Array(buffer);
    const data = await parse(uint8Array);
    return (data.text || '').trim();
  } catch (err) {
    console.warn('[ResumePdfExtractor] Direct PDF text extraction error:', err);
    return '';
  }
}
