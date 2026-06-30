import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, interactions } from "@/db/schema";
import { extractPersonalProfile } from "@/lib/personal/extract";

type Contact = typeof contacts.$inferSelect;

const STALE_MS = 120 * 86_400_000; // refresh personal facts ~quarterly
const CAP = 400; // bound per-run LLM cost; converges across nightly runs

/** Re-extract when never done, refreshed by newer enrichment, or quarterly-stale. */
function needs(c: Contact): boolean {
  if (c.isOrganization) return false;
  const pp = c.personalProfile as { extractedAt?: string } | null;
  if (!pp?.extractedAt) return true;
  const t = new Date(pp.extractedAt).getTime();
  if (!t) return true;
  if (c.enrichedAt && new Date(c.enrichedAt).getTime() > t) return true; // richer profile arrived
  return Date.now() - t > STALE_MS;
}

/** A few recent message snippets so interest extraction can learn from real conversations. */
async function snippetsFor(userId: string, contactId: string): Promise<string[]> {
  const rows = await db
    .select({ metadata: interactions.metadata })
    .from(interactions)
    .where(and(eq(interactions.userId, userId), eq(interactions.contactId, contactId)))
    .orderBy(desc(interactions.occurredAt))
    .limit(8);
  return rows
    .map((r) => {
      const m = (r.metadata ?? {}) as { subject?: string; text?: string };
      return (m.text || m.subject || "").toString().trim();
    })
    .filter(Boolean);
}

/**
 * Build the personal knowledge layer for the network — alma maters, city, work-anniversary date,
 * birthday, and interests. Deterministic fields are free; interests use one cheap LLM call only
 * when there's real text to read. Incremental + importance-first, bounded per run.
 */
export async function runPersonalProfile(): Promise<void> {
  const all = await db.select().from(contacts);
  const targets = all
    .filter(needs)
    .sort(
      (a, b) =>
        Number(Boolean(b.highValue)) - Number(Boolean(a.highValue)) || (b.relevance ?? 0) - (a.relevance ?? 0),
    )
    .slice(0, CAP);
  if (!targets.length) {
    console.log("[personal] nothing to extract");
    return;
  }
  let n = 0;
  for (const c of targets) {
    try {
      const convo = await snippetsFor(c.userId, c.id);
      const pp = await extractPersonalProfile(c, convo);
      await db.update(contacts).set({ personalProfile: pp }).where(eq(contacts.id, c.id));
      n++;
    } catch (e) {
      console.error("[personal] extract failed", c.id, e);
    }
  }
  console.log(`[personal] extracted ${n}/${targets.length} personal profile(s)`);
}
