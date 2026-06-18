import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, interactions } from "@/db/schema";
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

/**
 * Nightly recompute: turns observed interactions into reply-propensity,
 * relevance, status, and last_contacted — entirely from behavior, no keys
 * required. The learning core of Phase 0.
 */
export async function runRecompute(): Promise<void> {
  const all = await db.select().from(contacts);
  for (const c of all) {
    const ix = await db.select().from(interactions).where(eq(interactions.contactId, c.id));
    const f = computeFeatures(ix);
    const rp = scoreReplyPropensity(f);
    const cadence = cadenceForRelevance(c.relevance ?? null);

    const relevance = computeRelevance(DEFAULT_WEIGHTS, {
      professional: 0.5,
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
        lastContactedAt: latest ? new Date(latest) : c.lastContactedAt,
        gradedAt: new Date(),
      })
      .where(eq(contacts.id, c.id));
  }
  console.log(`[recompute] updated ${all.length} contacts`);
}
