import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { connectedAccounts, contacts } from "@/db/schema";
import { env, isConfigured } from "@/lib/env";
import { getUserPosts, type LinkedInPost } from "@/lib/integrations/unipile";
import { writeClaim } from "@/lib/provenance/claims";
import { complete } from "@/lib/llm";
import { reportProgress } from "@/lib/jobs/progress";

type Contact = typeof contacts.$inferSelect;

/**
 * LinkedIn ACTIVITY monitor — what a contact just said publicly is the single warmest,
 * most personal outreach trigger there is ("saw your post about X"). The messages poll
 * only covers conversations; this job watches their POSTS.
 *
 * Rotation: every contact clearing the news floor (VIP / fit / relevance), stalest
 * lastPostsCheckAt first, LI_POSTS_PER_RUN per run — conservative against LinkedIn
 * account limits (separate budget from the deep-profile pass). One cheap LLM read picks
 * the single most noteworthy recent post and writes it as a dated, sourced claim
 * (field "li_post") that the suggestion engine turns into a "react to their post" draft.
 */

function linkedinSlug(url?: string | null): string | null {
  if (!url) return null;
  const m = url.toLowerCase().match(/\/in\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]).replace(/\/+$/, "") : null;
}

function parseIso(s?: string | null): { iso: string; ageDays: number } | null {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return { iso: d.toISOString().slice(0, 10), ageDays: (Date.now() - d.getTime()) / 86_400_000 };
}

/** Pick the one post worth referencing (or none) — strict, so nudges stay rare and real. */
async function pickNoteworthy(
  c: Contact,
  posts: { p: LinkedInPost; d: { iso: string; ageDays: number } }[],
): Promise<{ post: LinkedInPost; iso: string; summary: string } | null> {
  const payload = posts.map((x, i) => ({
    i,
    text: x.p.text.slice(0, 400),
    date: x.d.iso,
    repost: x.p.isRepost,
    reactions: x.p.reactions,
  }));
  const raw = await complete({
    tier: "cheap",
    system:
      "You review a professional contact's recent LinkedIn posts for a relationship agent. " +
      "Pick the SINGLE most noteworthy post worth a warm, personal reaction from someone who knows them: a deal or fund announcement, a new role or promotion, a launch, an award, a milestone (personal or professional), or a substantive point of view they clearly care about. " +
      "Prefer their OWN posts over reposts. Ignore generic reshares, engagement-bait, event promos they merely attended, and anything political. " +
      'If nothing clears the bar, return i = null. Return JSON only: {"i": number|null, "summary": "one factual sentence describing what THEY posted"}.',
    messages: [
      {
        role: "user",
        content: `Person: ${c.name}; Company: ${c.company ?? "unknown"}; Role: ${c.role ?? "unknown"}.\nPosts: ${JSON.stringify(payload)}`,
      },
    ],
    maxTokens: 200,
    temperature: 0,
  });
  try {
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    if (typeof obj.i !== "number" || !posts[obj.i]) return null;
    const chosen = posts[obj.i];
    return { post: chosen.p, iso: chosen.d.iso, summary: String(obj.summary || chosen.p.text.slice(0, 140)) };
  } catch {
    return null;
  }
}

export async function runLinkedInActivity(): Promise<void> {
  if (!isConfigured("unipile")) {
    console.log("[li-activity] unipile not configured — skip");
    return;
  }
  const accts = await db
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.provider, "linkedin"));
  let flagged = 0;

  for (const acct of accts) {
    if (!acct.externalId) continue;
    const all = await db.select().from(contacts).where(eq(contacts.userId, acct.userId));
    // Same "valuable to the user's goals" pool as the news sweep, but the contact must be
    // reachable on LinkedIn (member id or public slug).
    const eligible = all.filter(
      (c) =>
        !c.isOrganization &&
        (c.linkedinMemberId || linkedinSlug(c.linkedinUrl)) &&
        (c.highValue || (c.professionalFit ?? 0) >= env.NEWS_FIT_FLOOR || (c.relevance ?? 0) >= 45),
    );
    eligible.sort((a, b) => {
      const at = a.lastPostsCheckAt ? new Date(a.lastPostsCheckAt).getTime() : 0;
      const bt = b.lastPostsCheckAt ? new Date(b.lastPostsCheckAt).getTime() : 0;
      if (at !== bt) return at - bt; // never-checked / stalest first
      return (
        Math.max(b.professionalFit ?? 0, (b.relevance ?? 0) / 100) -
        Math.max(a.professionalFit ?? 0, (a.relevance ?? 0) / 100)
      );
    });
    const batch = eligible.slice(0, env.LI_POSTS_PER_RUN);
    if (!batch.length) continue;

    let done = 0;
    for (const c of batch) {
      try {
        const identifier = c.linkedinMemberId || linkedinSlug(c.linkedinUrl)!;
        const posts = await getUserPosts(acct.externalId, identifier, 10);
        const recent = posts
          .map((p) => ({ p, d: parseIso(p.postedAt) }))
          .filter((x): x is { p: LinkedInPost; d: { iso: string; ageDays: number } } =>
            Boolean(x.d && x.d.ageDays >= 0 && x.d.ageDays <= env.LI_POSTS_WINDOW_DAYS),
          );
        if (recent.length) {
          const picked = await pickNoteworthy(c, recent);
          const url =
            picked?.post.url ??
            (picked?.post.id ? `https://www.linkedin.com/feed/update/urn:li:activity:${picked.post.id}/` : null);
          if (picked && url) {
            await writeClaim({
              contactId: c.id,
              field: "li_post",
              value: picked.summary,
              sourceUrl: url,
              eventDate: picked.iso,
              publishedDate: picked.iso,
              confidence: 0.85, // their own authored post on their own profile
            });
            flagged++;
          }
        }
      } catch (e) {
        console.error("[li-activity] contact failed", c.id, e);
      }
      done++;
      void reportProgress(done, batch.length, "Watching LinkedIn posts");
    }
    // One cursor update for the whole batch (attempted = checked, even when no posts found).
    await db
      .update(contacts)
      .set({ lastPostsCheckAt: new Date() })
      .where(and(eq(contacts.userId, acct.userId), inArray(contacts.id, batch.map((c) => c.id))));
  }
  console.log(`[li-activity] flagged ${flagged} noteworthy post(s) across ${accts.length} account(s)`);
}
