import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { env, isConfigured } from "@/lib/env";
import { search } from "@/lib/integrations/exa";
import { writeClaim } from "@/lib/provenance/claims";

/**
 * Enrichment — ENRICH ON SIGNAL, not on a clock. A contact is refreshed only if
 * never enriched or stale. Exa is date-windowed at the source; results are
 * written as SOURCED claims with publishedDate. event_date stays null here — the
 * Phase 1 extraction step sets it, so nothing is mistaken for "news" yet.
 */
export async function runEnrichment(): Promise<void> {
  if (!isConfigured("exa")) {
    console.log("[enrichment] exa not configured — skip");
    return;
  }
  const staleBefore = new Date(Date.now() - env.ENRICH_STALE_AFTER_DAYS * 86_400_000);
  const startDate = new Date(Date.now() - env.NEWS_FRESHNESS_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const all = await db.select().from(contacts);
  let enriched = 0;

  for (const c of all) {
    if (c.isOrganization) continue;
    const needs = !c.enrichedAt || new Date(c.enrichedAt) < staleBefore;
    if (env.ENRICH_ONLY_ON_SIGNAL && !needs) continue;

    const query = `${c.name} ${c.company ?? ""} funding OR announcement OR appointed OR award`;
    const results = await search({ query, startPublishedDate: startDate, numResults: 5 });
    for (const r of results) {
      await writeClaim({
        contactId: c.id,
        field: "news",
        value: r.title ?? r.highlights?.[0] ?? r.url,
        sourceUrl: r.url,
        publishedDate: r.publishedDate?.slice(0, 10) ?? null,
        eventDate: null,
        confidence: 0.5,
      });
    }
    await db.update(contacts).set({ enrichedAt: new Date() }).where(eq(contacts.id, c.id));
    enriched++;
  }
  console.log(`[enrichment] refreshed ${enriched} contacts (signal-gated)`);
}
