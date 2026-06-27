import type { contacts } from "@/db/schema";

/**
 * Per-contact outreach suppression, driven by the Telegram controls:
 *   • Block   → never surface ANY update for this person again.
 *   • Snooze  → mute everything until `outreachSnoozedUntil`.
 *   • Dismiss → suppress non-news check-ins; a genuine NEWS moment may still surface.
 *
 * `news` = the update is tied to a fresh sourced claim (job change / milestone), as opposed
 * to a relationship check-in (re_engage). Dismiss intentionally lets news through.
 */
type ContactFlags = Pick<
  typeof contacts.$inferSelect,
  "outreachBlocked" | "outreachSnoozedUntil" | "outreachDismissedAt"
>;

export const SNOOZE_DAYS = 30;

/** News-driven trigger types (vs. re_engage check-ins). */
export function isNewsTrigger(trigger: string | null | undefined): boolean {
  return trigger === "job_change" || trigger === "milestone";
}

export function outreachSuppressed(
  c: ContactFlags,
  news: boolean,
): { suppressed: boolean; reason?: "blocked" | "snoozed" | "dismissed" } {
  if (c.outreachBlocked) return { suppressed: true, reason: "blocked" };
  if (c.outreachSnoozedUntil && new Date(c.outreachSnoozedUntil).getTime() > Date.now()) {
    return { suppressed: true, reason: "snoozed" };
  }
  if (!news && c.outreachDismissedAt) return { suppressed: true, reason: "dismissed" };
  return { suppressed: false };
}
