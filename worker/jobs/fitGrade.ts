import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, userContext } from "@/db/schema";
import { gradeFitBatch, type FitInput, type UserFocus } from "@/lib/scoring/fit";
import { runRecompute } from "./recompute";

const BATCH = 6; // contacts per LLM call
const CONCURRENCY = 8; // batches in flight

const NOTES_KEY = /note|background|summary|description|comment/i;

/**
 * Score every contact's domain/thesis fit to the user's focus with an LLM, using all
 * available signal (role, firm, headline, notes, derived facets, deep profile). Stores
 * professionalFit + a "what they do/invest in" summary + rationale, then re-grades
 * relevance (which now treats fit as the dominant driver). Runs over ALL contacts so
 * under-ranked, off-keyword people (e.g. prominent secondaries investors) get evaluated.
 */
export async function runFitGrade(): Promise<void> {
  const us = await db.select().from(userContext);
  const ctxByUser = new Map(us.map((u) => [u.userId, u]));
  const all = await db.select().from(contacts);
  const people = all.filter((c) => !c.isOrganization);

  const byUser = new Map<string, typeof people>();
  for (const c of people) {
    const l = byUser.get(c.userId) ?? [];
    l.push(c);
    byUser.set(c.userId, l);
  }

  let graded = 0;
  for (const [userId, list] of byUser) {
    const ctx = ctxByUser.get(userId);
    const focus: UserFocus = {
      role: ctx?.role ?? null,
      currentFocus: ctx?.currentFocus ?? null,
      activeProjects: ctx?.activeProjects ?? null,
    };

    const inputs: FitInput[] = list.map((c) => {
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
        },
        profile: pd
          ? { headline: pd.headline, about: pd.about, experience: pd.experience, skills: pd.skills }
          : null,
      };
    });

    const batches: FitInput[][] = [];
    for (let i = 0; i < inputs.length; i += BATCH) batches.push(inputs.slice(i, i + BATCH));

    const results = new Map<string, { fit: number; summary: string; rationale: string }>();
    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const chunk = await Promise.all(
        batches.slice(i, i + CONCURRENCY).map((b) => gradeFitBatch(b, focus)),
      );
      for (const arr of chunk) for (const r of arr) results.set(r.id, r);
    }

    const updates = list
      .filter((c) => results.has(c.id))
      .map((c) => ({ id: c.id, ...results.get(c.id)! }));
    for (let i = 0; i < updates.length; i += 50) {
      await Promise.all(
        updates.slice(i, i + 50).map((u) =>
          db
            .update(contacts)
            .set({
              professionalFit: u.fit,
              ...(u.summary ? { summary: u.summary } : {}),
              ...(u.rationale ? { gradeRationale: u.rationale } : {}),
            })
            .where(eq(contacts.id, u.id)),
        ),
      );
    }
    graded += updates.length;
  }

  console.log(`[fit-grade] scored ${graded} contact(s)`);
  // Re-grade relevance now that fit is fresh (recompute treats fit as the dominant driver).
  await runRecompute();
}
