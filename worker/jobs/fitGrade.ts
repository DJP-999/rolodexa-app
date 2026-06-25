import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, userContext } from "@/db/schema";
import { gradeFitBatch, type FitInput, type UserFocus } from "@/lib/scoring/fit";
import { runRecompute } from "./recompute";

const BATCH = 6; // contacts per LLM call
const CONCURRENCY = 6; // batches in flight per round

const NOTES_KEY = /note|background|summary|description|comment/i;

type Contact = typeof contacts.$inferSelect;

/** Build the LLM fit input from a contact row — includes meeting-note intel. */
function buildFitInput(c: Contact): FitInput {
  const cf = (c.customFields ?? {}) as Record<string, string>;
  const nf = (c.normalizedFields ?? {}) as Record<string, string>;
  const notesKey = Object.keys(cf).find((k) => NOTES_KEY.test(k));
  const pd = (c.profileData ?? null) as {
    headline?: string | null;
    about?: string | null;
    experience?: Array<{ title?: string; position?: string; company?: string }> | null;
    skills?: string[] | null;
  } | null;
  return {
    id: c.id,
    name: c.name,
    role: c.role,
    company: c.company,
    industry: c.industry,
    location: c.location,
    relationship: c.relationship,
    notes: notesKey ? cf[notesKey] : null,
    derived: {
      "Firm Type": nf["Firm Type"],
      "Check Size": nf["Check Size"],
      Region: nf["Region"],
      Interests: nf["Interests"],
      Stage: nf["Stage"],
      "Deal Interest": cf["Deal Interest"],
      Sectors: cf["Sectors"],
      Portfolio: cf["Portfolio"],
      "Targets / wants": cf["Targets"],
      "Deal Structure": cf["Deal Structure"],
    },
    pitchbook: (c.pitchbookData ?? null) as Record<string, string> | null,
    profile: pd ? { headline: pd.headline, about: pd.about, experience: pd.experience, skills: pd.skills } : null,
  };
}

function focusFor(ctx: typeof userContext.$inferSelect | undefined): UserFocus {
  return { role: ctx?.role ?? null, currentFocus: ctx?.currentFocus ?? null, activeProjects: ctx?.activeProjects ?? null };
}

/** Grade one batch with a single retry, so a transient LLM error doesn't drop it. */
async function gradeWithRetry(inputs: FitInput[], focus: UserFocus) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await gradeFitBatch(inputs, focus);
    if (r.length) return r;
  }
  return [];
}

async function persist(updates: { id: string; fit: number; summary: string; rationale: string }[]) {
  for (let i = 0; i < updates.length; i += 50) {
    await Promise.all(
      updates.slice(i, i + 50).map((u) =>
        db
          .update(contacts)
          .set({
            professionalFit: u.fit,
            gradedAt: new Date(),
            ...(u.summary ? { summary: u.summary } : {}),
            ...(u.rationale ? { gradeRationale: u.rationale } : {}),
          })
          .where(eq(contacts.id, u.id)),
      ),
    );
  }
}

/**
 * Re-score domain/thesis fit for ALL contacts, then re-grade relevance. Hardened to be
 * resumable: contacts are ordered stalest-first (ungraded, then oldest gradedAt) and each
 * round is PERSISTED immediately — so a deploy/restart mid-run never loses prior progress,
 * and a later run simply continues with whoever is still stale.
 */
export async function runFitGrade(): Promise<void> {
  const us = await db.select().from(userContext);
  const ctxByUser = new Map(us.map((u) => [u.userId, u]));
  const all = await db.select().from(contacts);
  const people = all.filter((c) => !c.isOrganization);

  // Stalest first: ungraded (null fit) before graded, then oldest gradedAt.
  people.sort((a, b) => {
    const af = a.professionalFit == null ? 0 : 1;
    const bf = b.professionalFit == null ? 0 : 1;
    if (af !== bf) return af - bf;
    return (a.gradedAt ? new Date(a.gradedAt).getTime() : 0) - (b.gradedAt ? new Date(b.gradedAt).getTime() : 0);
  });

  const byUser = new Map<string, Contact[]>();
  for (const c of people) (byUser.get(c.userId) ?? byUser.set(c.userId, []).get(c.userId)!).push(c);

  let graded = 0;
  for (const [userId, list] of byUser) {
    const focus = focusFor(ctxByUser.get(userId));
    const roundSize = BATCH * CONCURRENCY;
    for (let i = 0; i < list.length; i += roundSize) {
      const slice = list.slice(i, i + roundSize);
      const batches: Contact[][] = [];
      for (let j = 0; j < slice.length; j += BATCH) batches.push(slice.slice(j, j + BATCH));
      const results = await Promise.all(batches.map((b) => gradeWithRetry(b.map(buildFitInput), focus)));
      const updates = results.flat().map((r) => ({ id: r.id, fit: r.fit, summary: r.summary, rationale: r.rationale }));
      await persist(updates); // commit each round so progress survives an interruption
      graded += updates.length;
    }
  }

  console.log(`[fit-grade] scored ${graded} contact(s)`);
  await runRecompute();
}

/**
 * Re-score a SINGLE contact's fit immediately (1 LLM call) and refresh relevance — used
 * the moment you confirm a meeting or edit a contact, so they re-rank without waiting on
 * a full-network pass.
 */
export async function gradeContactFit(contactId: string): Promise<void> {
  const c = (await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1))[0];
  if (!c || c.isOrganization) return;
  const ctx = (await db.select().from(userContext).where(eq(userContext.userId, c.userId)).limit(1))[0];
  const results = await gradeWithRetry([buildFitInput(c)], focusFor(ctx));
  const r = results[0];
  if (r) {
    await persist([{ id: c.id, fit: r.fit, summary: r.summary, rationale: r.rationale }]);
  }
  await runRecompute();
}
