import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, userContext } from "@/db/schema";

/**
 * Keep a contact's CRM role/firm in sync with their LinkedIn, and flag when the user's freeform
 * notes have likely gone stale. Two jobs:
 *   1. PICK THE RIGHT CURRENT ROLE. People hold several active roles at once (advisor, board,
 *      operating role). We choose the one most relevant to the user's stated focus so grading and
 *      display anchor on what matters to THIS user, not whichever LinkedIn lists first.
 *   2. AUTO-UPDATE JOB MOVES, with an audit trail. When the chosen current role differs from what
 *      the CRM stored, we update company/title, log the change (old → new + date), and mark the
 *      contact "info stale" so the user knows their notes may describe the prior situation.
 * Pure string/keyword logic — no LLM cost — so it can sweep the whole network cheaply.
 */

type Contact = typeof contacts.$inferSelect;
type Exp = { company?: string | null; position?: string | null; current?: boolean | null };
type Focus = { currentFocus?: string | null; activeProjects?: string | null; role?: string | null };

function toks(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);
}
function norm(s?: string | null): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Among a profile's CURRENT roles, the one most relevant to the user's focus. */
export function pickPrimaryRole(profileData: unknown, focus: Focus): { company: string | null; position: string | null } | null {
  const pd = profileData as { experience?: Exp[] } | null;
  const exp: Exp[] = Array.isArray(pd?.experience) ? pd!.experience! : [];
  const current = exp.filter((e) => e?.current && (e.company || e.position));
  if (!current.length) return null;
  if (current.length === 1) return { company: current[0].company ?? null, position: current[0].position ?? null };

  const needles = new Set(toks([focus.currentFocus, focus.activeProjects, focus.role].filter(Boolean).join(" ")));
  const score = (e: Exp): number => {
    const blob = `${e.company ?? ""} ${e.position ?? ""}`;
    const overlap = toks(blob).filter((t) => needles.has(t)).length * 3;
    // A gentle bias toward investing/capital roles, which are what a dealmaker cares about when a
    // contact also holds unrelated operating/advisory titles.
    const bias = /(invest|capital|ventures?|\bpartner\b|secondar|fund|equity|family office|allocat)/i.test(blob) ? 1 : 0;
    return overlap + bias;
  };
  const best = [...current].sort((a, b) => score(b) - score(a))[0];
  return { company: best.company ?? null, position: best.position ?? null };
}

/**
 * Compute the reconcile patch for one contact, or null if nothing changed.
 *
 * "Out of date" (the red flag + a job-change audit) fires ONLY on a genuine DEPARTURE — when the
 * CRM's company is no longer one of the person's CURRENT LinkedIn roles. It must NOT fire for:
 *   • concurrent roles — e.g. still President of Love Travel AND now a Venture Partner at PLP, or
 *   • a title that's merely worded differently — e.g. a CRM headline vs LinkedIn's concise title
 *     at the SAME company.
 * Role PRIORITIZATION (showing the most thesis-relevant current role) still happens, but quietly:
 * when there are multiple current COMPANIES we switch to the most relevant one with no flag. The
 * function is also self-healing: it strips false flags/audit entries left by the older logic.
 */
export function reconcileProfile(c: Contact, focus: Focus): Partial<Contact> | null {
  if (!c.profileData) return null;
  const pd = c.profileData as { experience?: Exp[] };
  const currentRoles = (Array.isArray(pd?.experience) ? pd.experience : []).filter(
    (e) => e?.current && (e.company || e.position),
  );
  if (!currentRoles.length) return null;
  const currentCompanies = new Set(currentRoles.map((e) => norm(e.company ?? "")).filter(Boolean));

  const primary = pickPrimaryRole(c.profileData, focus);
  if (!primary || !primary.company) return null; // need a current company to reason about moves

  const patch: Record<string, unknown> = {};
  const now = new Date();

  // Self-heal: keep ONLY genuine departures in the audit (a company whose old value is no longer
  // current). This drops title-only entries and concurrent-role "changes" the old logic recorded.
  const existing = c.fieldUpdates ?? [];
  const cleaned = existing.filter((u) => u.field === "company" && u.old && !currentCompanies.has(norm(u.old)));
  if (cleaned.length !== existing.length) patch.fieldUpdates = cleaned;

  const crmCompanyCurrent = !norm(c.company) || currentCompanies.has(norm(c.company));
  const genuineDeparture = !!norm(c.company) && !crmCompanyCurrent;

  if (genuineDeparture) {
    // A real job move: adopt the most-relevant current role, record it, flag the notes to review.
    const updates = [
      ...cleaned,
      { field: "company", old: c.company ?? null, new: primary.company, at: now.toISOString(), source: "linkedin" },
    ];
    patch.company = primary.company;
    if (primary.position && norm(primary.position) !== norm(c.role)) {
      updates.push({ field: "role", old: c.role ?? null, new: primary.position, at: now.toISOString(), source: "linkedin" });
      patch.role = primary.position;
    }
    patch.fieldUpdates = updates.slice(-20);
    patch.infoStale = true;
    patch.infoStaleAt = now;
    patch.infoStaleReason = `LinkedIn shows they're now at ${primary.company}${primary.position ? ` as ${primary.position}` : ""} and no longer lists ${c.company}. Your notes may describe their prior role; review and update.`;
    return patch as Partial<Contact>;
  }

  // Not a departure. Prioritize the most-relevant current role for display/grading, but quietly —
  // and only when it's a DIFFERENT current company (concurrent roles). A same-company title
  // difference is left untouched so we don't overwrite a richer CRM title or false-flag it.
  if (norm(primary.company) !== norm(c.company) && currentCompanies.has(norm(primary.company))) {
    patch.company = primary.company;
    if (primary.position) patch.role = primary.position;
  }

  // Clear a stale flag left by the old over-eager logic when there's no genuine departure on file.
  const hasGenuineDeparture = cleaned.length > 0;
  if (c.infoStale && !hasGenuineDeparture) {
    patch.infoStale = false;
    patch.infoStaleReason = null;
  }

  return Object.keys(patch).length ? (patch as Partial<Contact>) : null;
}

/**
 * Sweep every contact that has a LinkedIn profile, applying reconcile patches. Cheap (no LLM),
 * so it runs as part of the enrichment cycle. Returns how many contacts were auto-updated.
 */
export async function reconcileAllProfiles(): Promise<number> {
  const focusByUser = new Map<string, Focus>();
  for (const u of await db.select().from(userContext)) {
    focusByUser.set(u.userId, { currentFocus: u.currentFocus, activeProjects: u.activeProjects, role: u.role });
  }
  const all = await db.select().from(contacts);
  let updated = 0;
  for (const c of all) {
    if (c.isOrganization || !c.profileData) continue;
    const patch = reconcileProfile(c, focusByUser.get(c.userId) ?? {});
    if (!patch) continue;
    try {
      await db.update(contacts).set(patch).where(eq(contacts.id, c.id));
      updated++;
      if (patch.infoStale === true) {
        console.log(`[reconcile] ${c.name}: job move → ${patch.company ?? c.company} (flagged)`);
      } else if (patch.company || patch.role) {
        console.log(`[reconcile] ${c.name}: prioritized role → ${patch.company ?? c.company}${patch.role ? ` / ${patch.role}` : ""}`);
      } else {
        console.log(`[reconcile] ${c.name}: cleared false stale flag`);
      }
    } catch (e) {
      console.error(`[reconcile] failed for ${c.id}:`, String(e));
    }
  }
  if (updated) console.log(`[reconcile] auto-updated ${updated} contact(s) from LinkedIn`);
  return updated;
}

/** Clear the stale flag once the user has reviewed/updated their notes. */
export async function markInfoReviewed(userId: string, contactId: string): Promise<void> {
  await db
    .update(contacts)
    .set({ infoStale: false, infoStaleReason: null })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
}
