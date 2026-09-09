import { getDb } from "@/db";
import { settings } from "@/db/schema";
import { inArray } from "drizzle-orm";
import type { VerifiedProfileLinks } from "@/types";

const LINK_KEYS = {
  linkedin: "user_link_linkedin",
  github: "user_link_github",
  portfolio: "user_link_portfolio",
  other: "user_link_other",
} as const;

/**
 * Retrieves the user-verified profile links from the persistent settings table.
 * These are manually entered links (LinkedIn, GitHub, Portfolio) kept completely
 * distinct from resume-extracted facts.
 */
export function getUserVerifiedLinks(customDb?: ReturnType<typeof getDb>): VerifiedProfileLinks {
  try {
    const db = customDb || getDb();
    const rows = db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, Object.values(LINK_KEYS)))
      .all();

    const map = new Map<string, string>();
    for (const r of rows) {
      if (r.key && r.value) {
        map.set(r.key, r.value.trim());
      }
    }

    return {
      linkedin: map.get(LINK_KEYS.linkedin) || null,
      github: map.get(LINK_KEYS.github) || null,
      portfolio: map.get(LINK_KEYS.portfolio) || null,
      other: map.get(LINK_KEYS.other) || null,
    };
  } catch (err) {
    console.warn("[ProfileLinks] Failed to fetch verified links:", err);
    return {
      linkedin: null,
      github: null,
      portfolio: null,
      other: null,
    };
  }
}

/**
 * Saves or updates user-verified profile links persistently in the settings table.
 * Trims strings and saves non-empty URLs. Empty or whitespace strings are deleted or set to empty.
 */
export function saveUserVerifiedLinks(
  links: Partial<VerifiedProfileLinks>,
  customDb?: ReturnType<typeof getDb>
): VerifiedProfileLinks {
  const db = customDb || getDb();
  const now = new Date().toISOString();

  const entries: Array<[string, string | null]> = [
    [LINK_KEYS.linkedin, links.linkedin !== undefined ? (links.linkedin?.trim() || "") : null],
    [LINK_KEYS.github, links.github !== undefined ? (links.github?.trim() || "") : null],
    [LINK_KEYS.portfolio, links.portfolio !== undefined ? (links.portfolio?.trim() || "") : null],
    [LINK_KEYS.other, links.other !== undefined ? (links.other?.trim() || "") : null],
  ];

  for (const [key, val] of entries) {
    if (val !== null) {
      db.insert(settings)
        .values({ key, value: val, updatedAt: now })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: val, updatedAt: now },
        })
        .run();
    }
  }

  return getUserVerifiedLinks();
}
