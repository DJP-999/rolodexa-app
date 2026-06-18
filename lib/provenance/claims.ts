import { db } from "@/db";
import { claims, type Claim } from "@/db/schema";
import { env } from "@/lib/env";

/** The single writer for enrichment facts. No claim is stored without a source. */
export async function writeClaim(input: {
  contactId: string;
  field: string;
  value: string;
  sourceUrl?: string;
  eventDate?: string | null;
  publishedDate?: string | null;
  confidence?: number;
}): Promise<void> {
  if (!input.sourceUrl) {
    console.warn(`[claims] dropped unsourced claim for ${input.contactId}: ${input.field}`);
    return;
  }
  await db.insert(claims).values({
    contactId: input.contactId,
    field: input.field,
    value: input.value,
    sourceUrl: input.sourceUrl,
    eventDate: input.eventDate ?? null,
    publishedDate: input.publishedDate ?? null,
    confidence: input.confidence ?? 0.6,
  });
}

/**
 * "No date, no news" — an item is NEWS only if its EVENT date (not the page's
 * publish date) falls inside the freshness window. Undated facts are background.
 */
export function isNews(claim: Pick<Claim, "eventDate">, now = new Date()): boolean {
  if (!claim.eventDate) return false;
  const ageDays = (now.getTime() - new Date(claim.eventDate).getTime()) / 86_400_000;
  return ageDays >= 0 && ageDays <= env.NEWS_FRESHNESS_DAYS;
}
