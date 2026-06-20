import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, interactions, userContext } from "@/db/schema";
import { computeFeatures, scoreReplyPropensity } from "@/lib/scoring/replyPropensity";
import {
  computeRelevance,
  recencySignal,
  cadenceForRelevance,
  type Weights,
} from "@/lib/scoring/relevance";

const DEFAULT_WEIGHTS: Weights = {
  professional: 30,
  recency: 25,
  relationship: 20,
  geographic: 15,
  trigger: 0,
  replyPropensity: 10,
};

type Ctx = {
  role: string | null;
  currentFocus: string | null;
  activeProjects: string | null;
  priorityConnections: string | null;
  weights?: Record<string, number> | null;
} | null;

function tokenize(s: string): string[] {
  return Array.from(new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3)));
}

/**
 * Professional fit + priority flag, derived from the user's stated context.
 * No embeddings yet — keyword overlap between the contact and the user's focus/
 * projects, plus an explicit name match against priority connections. This is what
 * makes onboarding actually move the score.
 */
function professionalSignal(
  c: { name: string; company: string | null; role: string | null; industry: string | null; relationship: string | null },
  ctx: Ctx,
): { signal: number; priority: boolean } {
  if (!ctx) return { signal: 0.5, priority: false };
  const hay = [c.name, c.company, c.role, c.industry].filter(Boolean).join(" ").toLowerCase();
  const needles = tokenize([ctx.currentFocus, ctx.activeProjects, ctx.role].filter(Boolean).join(" "));
  const hits = needles.filter((t) => hay.includes(t)).length;
  let s = 0.35 + Math.min(0.4, hits * 0.1);

  let priority = false;
  if (ctx.priorityConnections && c.name) {
    const pri = ctx.priorityConnections.toLowerCase();
    const full = c.name.toLowerCase();
    const first = full.split(/\s+/)[0];
    if (pri.includes(full) || (first.length > 2 && pri.includes(first))) {
      s += 0.25;
      priority = true;
    }
  }
  if (c.relationship === "investor") s += 0.1;
  return { signal: Math.min(1, s), priority };
}

/**
 * Nightly recompute: turns observed interactions into reply-propensity, relevance,
 * status, and last_contacted, blended with the user's context. One pass over all
 * interactions (grouped in memory) keeps it fast enough to also run inline after
 * an import or a context edit.
 */
export async function runRecompute(): Promise<void> {
  const all = await db.select().from(contacts);
  const allIx = await db.select().from(interactions);

  const byContact = new Map<string, typeof allIx>();
  for (const it of allIx) {
    if (!it.contactId) continue;
    const list = byContact.get(it.contactId);
    if (list) list.push(it);
    else byContact.set(it.contactId, [it]);
  }

  const ctxCache = new Map<string, Ctx>();

  for (const c of all) {
    let ctx = ctxCache.get(c.userId);
    if (ctx === undefined) {
      ctx =
        ((await db
          .select()
          .from(userContext)
          .where(eq(userContext.userId, c.userId))
          .limit(1))[0] as Ctx) ?? null;
      ctxCache.set(c.userId, ctx);
    }

    const ix = byContact.get(c.id) ?? [];
    const f = computeFeatures(ix);
    const rp = scoreReplyPropensity(f);
    const cadence = cadenceForRelevance(c.relevance ?? null);
    const prof = professionalSignal(c, ctx);
    const w = ctx?.weights;
    const weights: Weights = w
      ? {
          professional: w.professional ?? 30,
          recency: w.recency ?? 25,
          relationship: w.relationship ?? 20,
          geographic: w.geographic ?? 15,
          trigger: w.trigger ?? 0,
          replyPropensity: w.replyPropensity || 10,
        }
      : DEFAULT_WEIGHTS;

    const relevance = computeRelevance(weights, {
      professional: prof.signal,
      recency: recencySignal(f.lastDays, cadence),
      relationship: Math.min(1, f.avgThreadDepth / 5),
      geographic: 0.3,
      trigger: 0,
      replyPropensity: rp,
    });

    let status: "active" | "warming" | "going_cold" | "dormant";
    const d = f.lastDays;
    if (d === null) status = "dormant";
    else if (d <= cadence * 0.5) status = "active";
    else if (d <= cadence) status = "warming";
    else if (d <= cadence * 2) status = "going_cold";
    else status = "dormant";

    const latest = ix.reduce<number>((mx, it) => Math.max(mx, new Date(it.occurredAt).getTime()), 0);

    await db
      .update(contacts)
      .set({
        replyPropensity: rp,
        rpFeatures: {
          inbound: f.inbound,
          outbound: f.outbound,
          meetings: f.meetings,
          replyRate: f.replyRate,
          initiationRatio: f.initiationRatio,
          avgThreadDepth: f.avgThreadDepth,
          lastDays: f.lastDays ?? -1,
        },
        relevance,
        status,
        highValue: prof.priority || c.highValue || false,
        lastContactedAt: latest ? new Date(latest) : c.lastContactedAt,
        gradedAt: new Date(),
      })
      .where(eq(contacts.id, c.id));
  }
  console.log(`[recompute] updated ${all.length} contacts`);
}
