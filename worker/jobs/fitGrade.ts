import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { contacts, interactions, userContext } from "@/db/schema";
import { env } from "@/lib/env";
import { researchFirm, researchFirms, firmKey } from "@/lib/research/firm";
import { reconcileAllProfiles } from "@/lib/sync/profileReconcile";
import { gradeFitBatch, type FitInput, type UserFocus } from "@/lib/scoring/fit";
import { reportPhase, reportProgress } from "@/lib/jobs/progress";
import { runRecompute } from "./recompute";

const BATCH = 6; // contacts per LLM call
const CONCURRENCY = 6; // batches in flight per round

const NOTES_KEY = /note|background|summary|description|comment/i;

type Contact = typeof contacts.$inferSelect;

/**
 * Recent email/LinkedIn thread topics per contact — first-hand evidence of what each contact
 * actually transacts with the user. A live deal thread ("Re: Discounted Lambda Cap Table
 * Transfer") proves an on-thesis counterparty even when their LinkedIn bio looks off-thesis.
 */
async function threadsByContact(
  userId: string,
  onlyContactId?: string,
  perContact = 6,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const where = onlyContactId
      ? and(eq(interactions.userId, userId), eq(interactions.contactId, onlyContactId))
      : and(eq(interactions.userId, userId), isNotNull(interactions.contactId));
    const rows = await db
      .select({
        contactId: interactions.contactId,
        channel: interactions.channel,
        direction: interactions.direction,
        metadata: interactions.metadata,
      })
      .from(interactions)
      .where(where)
      .orderBy(desc(interactions.occurredAt))
      .limit(onlyContactId ? 50 : 30000);
    for (const r of rows) {
      const cid = r.contactId;
      if (!cid) continue;
      const arr = out.get(cid) ?? [];
      if (arr.length >= perContact) continue; // keep the most recent N (rows are newest-first)
      const m = (r.metadata ?? {}) as { subject?: string; text?: string };
      const topic = (m.subject || m.text || "").toString().replace(/\s+/g, " ").trim();
      if (!topic) continue;
      const chan = r.channel === "linkedin" ? "LinkedIn" : r.channel === "nylas_email" ? "Email" : r.channel ?? "msg";
      const dir = r.direction === "outbound" ? "you→them" : "them→you";
      arr.push(`${chan} (${dir}): ${topic.slice(0, 120)}`);
      out.set(cid, arr);
    }
  } catch (e) {
    console.error("[fit-grade] threadsByContact", e);
  }
  return out;
}

/** Build the LLM fit input from a contact row — includes meeting-note intel and firm research. */
function buildFitInput(c: Contact, firmMap?: Map<string, string>, threads?: Map<string, string[]>): FitInput {
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
    firmResearch: c.company && firmMap ? firmMap.get(firmKey(c.company)) ?? null : null,
    recentThreads: threads?.get(c.id) ?? null,
    profile: pd ? { headline: pd.headline, about: pd.about, experience: pd.experience, skills: pd.skills } : null,
  };
}

/** Research firms of the most valuable contacts first: investors, then high relevance/fit, so
 *  on-thesis firms get a brief even when the per-run cap can't cover the whole long tail. */
function firmPriority(c: Contact): number {
  // Agnostic: importance is the user's own VIP flag + how well the contact fits THEIR stated goals
  // (relevance/fit) — never a hardcoded preference for any one industry or relationship type.
  return (c.highValue ? 1 : 0) + (c.relevance ?? 0) / 100 + (c.professionalFit ?? 0);
}

function focusFor(ctx: typeof userContext.$inferSelect | undefined): UserFocus {
  return {
    role: ctx?.role ?? null,
    currentFocus: ctx?.currentFocus ?? null,
    activeProjects: ctx?.activeProjects ?? null,
    priorityConnections: ctx?.priorityConnections ?? null,
  };
}

/** Grade one batch with a single retry, so a transient LLM error doesn't drop it. */
async function gradeWithRetry(inputs: FitInput[], focus: UserFocus) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await gradeFitBatch(inputs, focus);
    if (r.length) return r;
  }
  return [];
}

// Bump when the grading rubric changes so every contact re-grades exactly once. Combined with
// the strong-model id, this signature lets us detect both a model switch and a prompt change.
const GRADE_PROMPT_VERSION = "v5";
function gradeSignature(): string {
  const model =
    env.LLM_STRONG_PROVIDER === "openrouter"
      ? env.OPENROUTER_MODEL_STRONG || env.OPENROUTER_MODEL_CHEAP
      : env.LLM_MODEL_STRONG;
  return `${model}@${GRADE_PROMPT_VERSION}`;
}

/** Should this contact be (re-)graded now? Only when something that affects the grade changed. */
function needsGrade(c: Contact, sig: string): boolean {
  if (c.gradesLocked) return false; // user hand-set fit/relevance — never auto-overwrite
  if (c.professionalFit == null) return true; // never graded
  if ((c.fitGradedModel ?? "") !== sig) return true; // grading model OR rubric changed
  if ((c.company ?? "") !== (c.fitGradedCompany ?? "")) return true; // MOVED FIRMS
  const gradedAt = c.fitGradedAt ? new Date(c.fitGradedAt).getTime() : 0;
  if (!gradedAt) return true;
  if (c.enrichedAt && new Date(c.enrichedAt).getTime() > gradedAt) return true; // freshly enriched
  if (Date.now() - gradedAt > env.FIT_REGRADE_DAYS * 86_400_000) return true; // periodic refresh
  return false;
}

async function persist(
  updates: { id: string; fit: number; summary: string; rationale: string; company?: string | null }[],
) {
  const sig = gradeSignature();
  for (let i = 0; i < updates.length; i += 50) {
    await Promise.all(
      updates.slice(i, i + 50).map((u) =>
        db
          .update(contacts)
          .set({
            professionalFit: u.fit,
            gradedAt: new Date(),
            fitGradedAt: new Date(),
            fitGradedModel: sig,
            fitGradedCompany: u.company ?? null,
            ...(u.summary ? { summary: u.summary } : {}),
            ...(u.rationale ? { gradeRationale: u.rationale } : {}),
          })
          .where(eq(contacts.id, u.id))
          // Never let one bad row (e.g. a mangled id from the model) abort the whole job.
          .catch((e) => console.error(`[fit-grade] persist skipped id=${u.id}:`, String(e))),
      ),
    );
  }
}

/** Grade the contacts the user cares about FIRST — investors, high-value, then high
 *  relevance/fit — with a boost for never-graded contacts so brand-new imports still surface
 *  early. So a long pass updates the important people in the first minute, not the last. */
function gradePriority(c: Contact): number {
  // Agnostic ordering: the user's VIPs first, then never-graded (so new imports surface), then by
  // relevance + fit to the user's OWN goals. No industry/relationship type is privileged.
  return (
    (c.highValue ? 1000 : 0) +
    (c.professionalFit == null ? 300 : 0) +
    (c.relevance ?? 0) +
    (c.professionalFit ?? 0) * 100
  );
}

/**
 * Re-score domain/thesis fit for ALL contacts, then re-grade relevance. Resumable: each round
 * is PERSISTED immediately, so a deploy/restart mid-run never loses prior progress. Ordered
 * IMPORTANCE-first (investors / high relevance / high fit) so the contacts the user actually
 * watches re-grade at the start of the pass rather than the end.
 */
export async function runFitGrade(): Promise<void> {
  // First reconcile LinkedIn → CRM (pick the focus-relevant current role, auto-apply job moves,
  // flag stale notes). A contact whose firm just changed will then be detected below as needing
  // a re-grade, with fresh firm research for the new firm.
  await reportPhase("Reconciling profiles");
  await reconcileAllProfiles();

  const us = await db.select().from(userContext);
  const ctxByUser = new Map(us.map((u) => [u.userId, u]));
  const all = await db.select().from(contacts);
  // INCREMENTAL: only grade contacts that are new, moved firms, freshly enriched, periodically
  // stale, or whose grading model/rubric changed — instead of the whole network every run.
  const sig = gradeSignature();
  const people = all.filter((c) => !c.isOrganization && needsGrade(c, sig));
  console.log(`[fit-grade] ${people.length}/${all.length} contact(s) need (re)grading [sig=${sig}]`);
  if (!people.length) {
    console.log("[fit-grade] nothing to grade — skipping");
    return;
  }

  people.sort((a, b) => gradePriority(b) - gradePriority(a));

  const byUser = new Map<string, Contact[]>();
  for (const c of people) (byUser.get(c.userId) ?? byUser.set(c.userId, []).get(c.userId)!).push(c);

  const totalToGrade = people.length;
  let graded = 0;
  for (const [userId, list] of byUser) {
    const focus = focusFor(ctxByUser.get(userId));
    // First-hand deal evidence: the recent threads this user has with each contact.
    const threads = await threadsByContact(userId);
    // Research this user's firms cache-first (capped), investors/high-value first so the budget
    // lands on the contacts that matter most. Cache persists, so coverage converges across runs.
    const firmOrder = [...list].sort((a, b) => firmPriority(b) - firmPriority(a));
    const companies = firmOrder.map((c) => c.company).filter((x): x is string => !!x);
    // Surface the firm-research preamble as its own live phase — it's the long pole on a first
    // full re-grade, so without this the bar would sit at 0% for minutes with no explanation.
    const firmMap = await researchFirms(companies, env.FIRM_RESEARCH_CAP, (d, t) =>
      void reportProgress(d, t, "Researching firms"),
    );
    console.log(`[fit-grade] ${firmMap.size} firm brief(s) available (user ${userId})`);
    const roundSize = BATCH * CONCURRENCY;
    for (let i = 0; i < list.length; i += roundSize) {
      const slice = list.slice(i, i + roundSize);
      const batches: Contact[][] = [];
      for (let j = 0; j < slice.length; j += BATCH) batches.push(slice.slice(j, j + BATCH));
      const results = await Promise.all(batches.map((b) => gradeWithRetry(b.map((c) => buildFitInput(c, firmMap, threads)), focus)));
      const companyById = new Map(slice.map((c) => [c.id, c.company]));
      const updates = results
        .flat()
        .map((r) => ({ id: r.id, fit: r.fit, summary: r.summary, rationale: r.rationale, company: companyById.get(r.id) ?? null }));
      await persist(updates); // commit each round so progress survives an interruption
      graded += updates.length;
      await reportProgress(graded, totalToGrade, "Grading contacts");
    }
  }

  console.log(`[fit-grade] scored ${graded} contact(s)`);
  await reportPhase("Recomputing relevance");
  await runRecompute();
}

/**
 * Re-score a SINGLE contact's fit immediately (1 LLM call) and refresh relevance — used
 * the moment you confirm a meeting or edit a contact, so they re-rank without waiting on
 * a full-network pass.
 */
export async function gradeContactFit(contactId: string): Promise<void> {
  const c = (await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1))[0];
  if (!c || c.isOrganization || c.gradesLocked) return; // respect a manual fit/relevance override
  const ctx = (await db.select().from(userContext).where(eq(userContext.userId, c.userId)).limit(1))[0];
  const firmMap = new Map<string, string>();
  if (c.company) {
    const s = await researchFirm(c.company);
    if (s) firmMap.set(firmKey(c.company), s);
  }
  const threads = await threadsByContact(c.userId, c.id);
  const results = await gradeWithRetry([buildFitInput(c, firmMap, threads)], focusFor(ctx));
  const r = results[0];
  if (r) {
    await persist([{ id: c.id, fit: r.fit, summary: r.summary, rationale: r.rationale, company: c.company }]);
  }
  await runRecompute();
}
