/**
 * Shared multiline highlight and bullet rendering utilities for Candidate Profile.
 *
 * Requirements:
 * 1. Future textarea saves:
 *    - Detect logical list items using actual user-entered markers (e.g. 1), 2., -, •, etc.).
 *    - Preserve user-entered markers without stripping or altering them.
 *    - Group continuation lines into the same logical item.
 *    - Preserve continuation newlines as \n inside that item (never convert to space).
 *    - If no markers are present at all in the input, treat each non-empty line as a distinct item.
 * 2. Existing stored data:
 *    - Normalize fragmented highlight arrays in memory on the fly.
 *    - Do not modify database records.
 *    - Group continuation lines into preceding marked items with \n.
 */

export const LIST_MARKER_REGEX =
  /^(\d+[\.\)\:]|\d+\s*[\-\–]|\(\d+\)|\[\d+\]|(?:[a-zA-Z]|[ivxIVX]+)[\.\)]|\((?:[a-zA-Z]|[ivxIVX]+)\)|[•\-\*–—\+])(?:\s+|$)/;

/**
 * Checks whether a single trimmed line begins with a list marker.
 */
export function hasListMarker(line: string): boolean {
  return LIST_MARKER_REGEX.test(line.trim());
}

/**
 * Parses raw text from a textarea into an array of logical highlight items.
 *
 * If markers (e.g. 1), 2., -, etc.) are present in the text:
 * - Each marked line starts a new logical item.
 * - Any subsequent lines that do NOT start with a marker are treated as continuation lines
 *   and appended to the current item using \n (preserving user line breaks).
 * - Interstitial blank lines between items are cleanly trimmed so they don't produce trailing newlines.
 * - Blank lines inside a multiline item (e.g. intentional paragraph breaks) are preserved.
 *
 * If NO markers are detected anywhere in the text:
 * - Treats each non-empty line as an individual item (preserving standard behavior for plain lists).
 */
export function parseRawHighlightsText(rawText: string | null | undefined): string[] {
  if (!rawText || typeof rawText !== 'string') {
    return [];
  }

  const rawLines = rawText.split(/\r?\n/);
  const hasAnyMarkers = rawLines.some((l) => hasListMarker(l));

  // If user entered plain lines with no markers at all, return each non-empty trimmed line
  if (!hasAnyMarkers) {
    return rawLines.map((l) => l.trim()).filter(Boolean);
  }

  const items: string[] = [];
  let currentLines: string[] = [];

  const flushCurrent = () => {
    if (currentLines.length > 0) {
      // Trim leading and trailing empty lines from the current item
      while (currentLines.length > 0 && currentLines[0].trim() === '') {
        currentLines.shift();
      }
      while (currentLines.length > 0 && currentLines[currentLines.length - 1].trim() === '') {
        currentLines.pop();
      }
      if (currentLines.length > 0) {
        items.push(currentLines.join('\n').trim());
      }
      currentLines = [];
    }
  };

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (hasListMarker(trimmed)) {
      flushCurrent();
      currentLines.push(trimmed);
    } else if (trimmed === '') {
      // Blank line: could be paragraph break within item or spacing between items.
      // If we are currently accumulating, push empty string. If the next line is a marker,
      // flushCurrent will pop trailing empty strings.
      if (currentLines.length > 0) {
        currentLines.push('');
      }
    } else {
      // Non-empty continuation line
      if (currentLines.length > 0) {
        currentLines.push(trimmed);
      } else {
        // Line before any marker
        currentLines.push(trimmed);
      }
    }
  }

  flushCurrent();
  return items.filter(Boolean);
}

/**
 * Normalizes an array of highlights (such as those already stored in SQLite) in memory.
 *
 * If existing data contains fragmented lines (e.g. ["1) First part...", "continuation line..."]):
 * - Detects that markers are present in the array.
 * - Groups un-marked continuation lines into the preceding marked item joined with \n.
 * - If no markers are present in the array, returns the cleaned array items as-is.
 * - Never modifies database state; returns a newly constructed array.
 */
export function normalizeHighlightItems(items: (string | null | undefined)[] | null | undefined): string[] {
  if (!items || !Array.isArray(items) || items.length === 0) {
    return [];
  }

  const cleanItems = items
    .filter((it): it is string => typeof it === 'string' && it.trim().length > 0)
    .map((it) => it.trim());

  if (cleanItems.length === 0) {
    return [];
  }

  const hasAnyMarkers = cleanItems.some((item) => hasListMarker(item));
  if (!hasAnyMarkers) {
    return cleanItems;
  }

  const result: string[] = [];
  let currentItem: string | null = null;

  for (const item of cleanItems) {
    if (hasListMarker(item)) {
      if (currentItem !== null) {
        result.push(currentItem);
      }
      currentItem = item;
    } else {
      if (currentItem !== null) {
        // Group continuation line into preceding marked item with \n
        currentItem = `${currentItem}\n${item}`;
      } else {
        // Unmarked item before any marked item
        currentItem = item;
      }
    }
  }

  if (currentItem !== null) {
    result.push(currentItem);
  }

  return result;
}
