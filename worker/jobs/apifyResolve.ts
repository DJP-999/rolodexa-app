import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { env } from "@/lib/env";
import {
  apifyConfigured,
  apifyItemName,
  apifyItemUrl,
  normalizeApifyProfile,
  searchLinkedInProfiles,
} from "@/lib/integrations/apify";
import { nameKey } from "@/lib/match/entity";

type Contact = typeof contacts.$inferSelect;

const CONCURRENCY = 4; // search runs are pricier/slower than direct scrapes — keep it modest
const STALE_MS = env.ENRICH_STALE_AFTER_DAYS * 86_400_000;

function hasUrl(url?: string | null): boolean {
  return !!url && /\/in\//i.test(url);
}

function needsProfile(c: Contact): boolean {
  const pd = (c.profileData ?? null) as { fetchedAt?: string } | null;
  if (!pd) return true;
  const t = pd.fetchedAt ? new Date(pd.fetchedAt).getTime() : 0;
  return !t || Date.now() - t > STALE_MS;
}

/**
 * Resolve + enrich contacts that have NO LinkedIn URL. Uses the search actor to find each
 * person by a "name + company" fuzzy query, verifies the returned name actually matches
 * (conservative — skip rather than risk enriching the wrong person), then stores the
 * resolved URL + full profile. Bounded per run; highest-relevance first. No-ops without a token.
 */
export async function runApifyResolve(): Promise<void> {
  if (!apifyConfigured()) {
    console.log("[apify-resolve] APIFY_TOKEN not set — skip");
    return;
  }

  const all = await db.select().from(contacts);
  const targets = all
    .filter(
      (c) =>
        !c.isOrganization &&
        !hasUrl(c.linkedinUrl) &&
        c.name &&
        c.company &&
        needsProfile(c),
    )
    .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
    .slice(0, env.APIFY_RESOLVE_DAILY_CAP);

  if (!targets.length) {
    console.log("[apify-resolve] nothing to resolve");
    return;
  }

  let resolved = 0;
  let missed = 0;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const slice = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (c) => {
        const items = await searchLinkedInProfiles(`${c.name} ${c.company}`, 3);
        const want = nameKey(c.name);
        const match = items.find((it) => nameKey(apifyItemName(it)) === want) ?? null;
        return { c, match };
      }),
    );
    for (const { c, match } of results) {
      if (!match) {
        missed++;
        continue;
      }
      const url = apifyItemUrl(match);
      const normalized = normalizeApifyProfile(match);
      const exp = normalized.experience as Array<{ company: string | null; position: string | null; current: boolean }>;
      const cur = exp.find((e) => e.current) ?? exp[0];
      const company = (normalized.currentCompany as string | null) || cur?.company || c.company;
      const role = cur?.position || c.role;
      await db
        .update(contacts)
        .set({
          ...(url ? { linkedinUrl: url } : {}),
          profileData: normalized,
          company,
          role,
          isVerifiedPerson: true,
          enrichedAt: new Date(),
        })
        .where(eq(contacts.id, c.id));
      resolved++;
    }
  }

  console.log(`[apify-resolve] resolved ${resolved}, no-match ${missed}, of ${targets.length} target(s)`);
}
