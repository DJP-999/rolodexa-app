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

/** Compute the reconcile patch for one contact, or null if nothing changed. */
export function reconcileProfile(c: Contact, focus: Focus): Partial<Contact> | null {
  if (!c.profileData) return null;
  const primary = pickPrimaryRole(c.profileData, focus);
  if (!primary || (!primary.company && !primary.position)) return null;

  const updates = [...(c.fieldUpdates ?? [])];
  const patch: Record<string, unknown> = {};
  const now = new Date();
  let companyChanged = false;

  if (primary.company && norm(primary.company) !== norm(c.company)) {
    updates.push({ field: "company", old: c.company ?? null, new: primary.company, at: now.toISOString(), source: "linkedin" });
    patch.company = primary.company;
    companyChanged = true;
  }
  if (primary.position && norm(primary.position) !== norm(c.role)) {
    updates.push({ field: "role", old: c.role ?? null, new: primary.position, at: now.toISOString(), source: "linkedin" });
    patch.role = primary.position;
  }
  if (!("company" in patch) && !("role" in patch)) return null;

  patch.fieldUpdates = updates.slice(-20); // keep recent history bounded
  // The structured fields are auto-fixed, but the user's freeform notes can't be — flag them.
  patch.infoStale = true;
  patch.infoStaleAt = now;
  patch.infoStaleReason = companyChanged
    ? `LinkedIn now shows ${primary.company}${primary.position ? ` — ${primary.position}` : ""}. Your saved notes may still describe their prior role; review and update.`
    : `LinkedIn now shows the title "${primary.position}". Your notes may be out of date.`;
  return patch as Partial<Contact>;
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
      await db.update(contacts).set({ ...patch, updatedAt: new Date() }).where(eq(contacts.id, c.id));
      updated++;
      const fu = (patch.fieldUpdates ?? []) as Array<{ field: string; old: string | null; new: string }>;
      const last = fu[fu.length - 1];
      console.log(`[reconcile] ${c.name}: ${last?.field} "${last?.old ?? "—"}" → "${last?.new}"`);
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
    .set({ infoStale: false, infoStaleReason: null, updatedAt: new Date() })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
}
