import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { env } from "@/lib/env";
import {
  apifyConfigured,
  apifyItemSlug,
  fetchLinkedInProfilesRaw,
  normalizeApifyProfile,
} from "@/lib/integrations/apify";

type Contact = typeof contacts.$inferSelect;

const BATCH = 25; // profile URLs per synchronous actor run
const STALE_MS = env.ENRICH_STALE_AFTER_DAYS * 86_400_000;

/** LinkedIn public slug from a profile URL, lowercased. */
function slugFromUrl(url?: string | null): string | null {
  if (!url) return null;
  const m = String(url).match(/\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

/** Whether a contact needs an Apify profile fetch: never enriched, or its profile is stale. */
function needsProfile(c: Contact): boolean {
  const pd = (c.profileData ?? null) as { fetchedAt?: string } | null;
  if (!pd) return true;
  const t = pd.fetchedAt ? new Date(pd.fetchedAt).getTime() : 0;
  return !t || Date.now() - t > STALE_MS;
}

/**
 * Bulk LinkedIn profile enrichment via Apify — the PRIMARY full-profile source, with no
 * per-account rate limit. Enriches every contact that has a LinkedIn URL and is missing
 * or stale, highest-relevance first, bounded per run. Stores the full profile into
 * profileData and refreshes company/role from the current position. No-ops without a token.
 */
export async function runApifyEnrich(): Promise<void> {
  if (!apifyConfigured()) {
    console.log("[apify-enrich] APIFY_TOKEN not set — skip");
    return;
  }

  const all = await db.select().from(contacts);
  const targets = all
    .filter((c) => !c.isOrganization && slugFromUrl(c.linkedinUrl) && needsProfile(c))
    // Never-enriched first, then highest relevance — so the most important profiles land first.
    .sort((a, b) => {
      const an = a.profileData ? 1 : 0;
      const bn = b.profileData ? 1 : 0;
      if (an !== bn) return an - bn;
      return (b.relevance ?? 0) - (a.relevance ?? 0);
    })
    .slice(0, env.APIFY_PROFILE_DAILY_CAP);

  if (!targets.length) {
    console.log("[apify-enrich] nothing to enrich");
    return;
  }

  let enriched = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const slice = targets.slice(i, i + BATCH);
    const bySlug = new Map<string, Contact>();
    for (const c of slice) {
      const s = slugFromUrl(c.linkedinUrl);
      if (s) bySlug.set(s, c);
    }
    const urls = slice.map((c) => c.linkedinUrl!).filter(Boolean);

    const items = await fetchLinkedInProfilesRaw(urls);
    for (const item of items) {
      const slug = apifyItemSlug(item);
      const c = slug ? bySlug.get(slug) : undefined;
      if (!c) continue;
      const normalized = normalizeApifyProfile(item);
      const exp = normalized.experience as Array<{ company: string | null; position: string | null; current: boolean }>;
      const cur = exp.find((e) => e.current) ?? exp[0];
      const company = cur?.company || c.company;
      const role = cur?.position || c.role;
      await db
        .update(contacts)
        .set({ profileData: normalized, company, role, isVerifiedPerson: true, enrichedAt: new Date() })
        .where(eq(contacts.id, c.id));
      enriched++;
    }
  }

  console.log(`[apify-enrich] enriched ${enriched}/${targets.length} profile(s)`);
}
