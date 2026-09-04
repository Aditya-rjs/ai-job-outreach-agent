// @ts-expect-error - import direct lib to bypass pdf-parse debug file ENOENT bug
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { createWorker } from 'tesseract.js';
import { callGemini, getGeminiClient } from '@/lib/ai/gemini-client';
import type { NormalizedContactRecord } from './field-mapper';

/**
 * Extracts text from a PDF buffer. If text is sparse (< 50 chars), triggers OCR fallback.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  let text = '';

  try {
    const parse =
      typeof pdfParse === 'function'
        ? pdfParse
        : (pdfParse as unknown as { default: (b: Buffer) => Promise<{ text: string }> }).default;
    const data = await parse(buffer);
    text = (data.text || '').trim();
  } catch (err) {
    console.warn('Direct PDF text extraction failed, trying OCR:', err);
  }

  // Check if extracted text is substantial
  const alphanumericCount = (text.match(/[a-zA-Z0-9]/g) || []).length;
  if (alphanumericCount >= 50) {
    return text;
  }

  // Fallback: Perform OCR if buffer represents an image or text is sparse
  try {
    const isImage =
      buffer.slice(0, 4).toString('hex') === '89504e47' || // PNG
      buffer.slice(0, 2).toString('hex') === 'ffd8'; // JPEG
    if (isImage) {
      const worker = await createWorker('eng');
      const ret = await worker.recognize(buffer);
      await worker.terminate();
      const ocrText = (ret.data.text || '').trim();
      return ocrText || text;
    }
    return text;
  } catch (ocrErr) {
    console.warn('Tesseract OCR fallback encountered an issue:', ocrErr);
    return text;
  }
}

/**
 * Deterministic fallback to extract contacts from unstructured text using regex.
 */
function extractContactsWithRegex(text: string): NormalizedContactRecord[] {
  const records: NormalizedContactRecord[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;

  for (const line of lines) {
    const match = line.match(emailRegex);
    if (!match) continue;

    const email = match[1].trim();

    // Check if line is separated by commas, pipes, or tabs
    const separators = [',', '|', '\t'];
    let parts: string[] = [];

    for (const sep of separators) {
      if (line.includes(sep)) {
        parts = line.split(sep).map((p) => p.trim());
        break;
      }
    }

    let companyName = '';
    let contactName = '';

    if (parts.length >= 2) {
      const remaining = parts.filter((p) => !p.includes(email));
      if (remaining.length > 0) companyName = remaining[0];
      if (remaining.length > 1) contactName = remaining[1];
    } else {
      // Try space split excluding email
      const cleanLine = line.replace(email, '').trim();
      if (cleanLine) {
        const words = cleanLine.split(/\s{2,}/);
        if (words.length > 1) {
          companyName = words[0].trim();
          contactName = words[1].trim();
        } else {
          companyName = cleanLine;
        }
      }
    }

    records.push({
      companyName: companyName || '',
      contactName,
      email,
    });
  }

  return records;
}

/**
 * Uses Gemini to extract structured contact records from raw PDF text.
 */
async function extractContactsWithAI(text: string): Promise<NormalizedContactRecord[]> {
  const prompt = `You are an expert document parser. Extract all company and recruiter contact records from the following text into structured JSON.

Rules:
1. Extract only information present in the text. NEVER invent or hallucinate missing data.
2. If a contact name is not found, leave contactName as "".
3. If a company name is not found, leave companyName as "".
4. Email is required for outreach.
5. Retain any optional designation, companyWebsite, or companyLocation if explicitly mentioned.

Text to extract from:
---
${text.slice(0, 15000)}
---

Respond ONLY with a JSON array of objects with the following schema:
[
  {
    "companyName": "string",
    "contactName": "string",
    "email": "string",
    "designation": "string (optional)",
    "companyWebsite": "string (optional)",
    "companyLocation": "string (optional)"
  }
]
Do not include markdown fences, extra notes, or explanations.`;

  try {
    const responseText = await callGemini(prompt, { temperature: 0.1 });
    const cleaned = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) {
      throw new Error('AI response is not an array');
    }

    return parsed
      .filter((item) => item && typeof item.email === 'string' && item.email.trim().length > 0)
      .map((item) => ({
        companyName: typeof item.companyName === 'string' ? item.companyName.trim() : '',
        contactName: typeof item.contactName === 'string' ? item.contactName.trim() : '',
        email: item.email.trim(),
        designation: typeof item.designation === 'string' ? item.designation.trim() : undefined,
        companyWebsite: typeof item.companyWebsite === 'string' ? item.companyWebsite.trim() : undefined,
        companyLocation: typeof item.companyLocation === 'string' ? item.companyLocation.trim() : undefined,
      }));
  } catch (err) {
    console.warn('AI PDF contact extraction failed, falling back to regex extraction:', err);
    return extractContactsWithRegex(text);
  }
}

/**
 * Main PDF parsing entry point. Extracts raw text and parses it into normalized contact records.
 */
export async function parsePdf(buffer: Buffer): Promise<NormalizedContactRecord[]> {
  const text = await extractPdfText(buffer);
  if (!text || text.trim().length === 0) {
    return [];
  }

  // If Gemini is available, use AI extraction for higher fidelity
  if (getGeminiClient()) {
    try {
      const records = await extractContactsWithAI(text);
      if (records.length > 0) {
        return records;
      }
    } catch {
      // fallback to regex
    }
  }

  return extractContactsWithRegex(text);
}
