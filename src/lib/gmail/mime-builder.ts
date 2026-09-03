export interface AttachmentOptions {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface BuildEmailOptions {
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  attachment?: AttachmentOptions;
}

/**
 * Escapes HTML characters for simple, clean HTML rendering of plain-text email bodies.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Builds an RFC 2822 MIME message string and returns URL-safe Base64 encoding ready for the Gmail API.
 */
export function buildMimeMessage(options: BuildEmailOptions): string {
  const { from, to, subject, bodyText, attachment } = options;

  // Sanitize headers to prevent CRLF injection
  const safeFrom = from.replace(/[\r\n]/g, '').trim();
  const safeTo = to.replace(/[\r\n]/g, '').trim();
  const safeSubject = subject.replace(/[\r\n]/g, '').trim();

  // Create boundary strings
  const boundaryMixed = `mixed_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  const boundaryAlt = `alt_${Date.now()}_${Math.random().toString(36).substring(2)}`;

  // Encode subject line properly in UTF-8 (Q/B encoding)
  const encodedSubject = `=?UTF-8?B?${Buffer.from(safeSubject, 'utf-8').toString('base64')}?=`;

  // Format simple, clean HTML version (preserving paragraphs and line breaks)
  const escapedParagraphs = bodyText
    .split(/\r?\n\r?\n/)
    .map((p) => `<p style="margin: 0 0 12px 0; line-height: 1.5;">${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('\n');

  const htmlBody = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; color: #111827; background-color: #ffffff; margin: 0; padding: 0;">
  ${escapedParagraphs}
</body>
</html>`;

  const lines: string[] = [];

  // 1. Headers
  lines.push(`From: ${safeFrom}`);
  lines.push(`To: ${safeTo}`);
  lines.push(`Subject: ${encodedSubject}`);
  lines.push('MIME-Version: 1.0');

  if (attachment) {
    // Multipart/mixed with alternative text/html and attachment
    lines.push(`Content-Type: multipart/mixed; boundary="${boundaryMixed}"`);
    lines.push('');

    // Alternative container
    lines.push(`--${boundaryMixed}`);
    lines.push(`Content-Type: multipart/alternative; boundary="${boundaryAlt}"`);
    lines.push('');

    // Plain text part
    lines.push(`--${boundaryAlt}`);
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('');
    lines.push(bodyText);
    lines.push('');

    // HTML part
    lines.push(`--${boundaryAlt}`);
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('');
    lines.push(htmlBody);
    lines.push('');
    lines.push(`--${boundaryAlt}--`);
    lines.push('');

    // Attachment part
    const sanitizedFilename = attachment.filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    lines.push(`--${boundaryMixed}`);
    lines.push(`Content-Type: ${attachment.contentType}; name="${sanitizedFilename}"`);
    lines.push(`Content-Disposition: attachment; filename="${sanitizedFilename}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    // Split base64 into 76-character chunks according to MIME RFC specs
    const base64Content = attachment.content.toString('base64');
    const chunkSize = 76;
    for (let i = 0; i < base64Content.length; i += chunkSize) {
      lines.push(base64Content.substring(i, i + chunkSize));
    }
    lines.push('');
    lines.push(`--${boundaryMixed}--`);
  } else {
    // Simple multipart/alternative without attachment
    lines.push(`Content-Type: multipart/alternative; boundary="${boundaryAlt}"`);
    lines.push('');

    // Plain text part
    lines.push(`--${boundaryAlt}`);
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('');
    lines.push(bodyText);
    lines.push('');

    // HTML part
    lines.push(`--${boundaryAlt}`);
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('');
    lines.push(htmlBody);
    lines.push('');
    lines.push(`--${boundaryAlt}--`);
  }

  const rawMime = lines.join('\r\n');

  // URL-safe base64 encode for Gmail API (replace + with -, / with _, and strip =)
  return Buffer.from(rawMime, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
