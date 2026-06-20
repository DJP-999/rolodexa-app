import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, connectedAccounts } from "@/db/schema";
import { env, isConfigured } from "@/lib/env";
import { search } from "@/lib/integrations/exa";
import { getAllRelations } from "@/lib/integrations/unipile";
import { writeClaim } from "@/lib/provenance/claims";
import { complete } from "@/lib/llm";
import { runRecompute } from "./recompute";

const norm = (s: string) => s.trim().toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Parse a LinkedIn headline conservatively. We only trust the unambiguous
 * "Title at Company" pattern (a single ' at ', no other separators) so messy
 * multi-part headlines never produce a false employer — false job-change alerts
 * are exactly the trust-killer we're avoiding.
 */
function parseHeadline(headline?: string | null): { title: string | null; company: string | null } {
  if (!headline) return { title: null, company: null };
  const h = headline.trim();
  const parts = h.split(/\s+at\s+/i);
  if (parts.length === 2 && !/[|·•/]/.test(h)) {
    return { title: parts[0].trim() || null, company: parts[1].trim() || null };
  }
  return { title: h || null, company: null };
}

/** A genuine employer change — not a re-phrasing or sub/superset of the same name. */
function isRealChange(oldC: string | null, newC: string | null): boolean {
  if (!oldC || !newC) return false;
  const a = norm(oldC);
  const b = norm(newC);
  if (!a || !b || a === b) return false;
  if (a.includes(b) || b.includes(a)) return false;
  return true;
}

/** Batched cheap-model categorization into relationship boxes. */
async function categorize(
  batch: { id: string; name: string; company: string | null; role: string | null }[],
): Promise<Record<string, string>> {
  if (!batch.length) return {};
  const valid = new Set(["family", "friend", "coworker", "investor", "vendor", "other"]);
  const raw = await complete({
    tier: "cheap",
    system:
      "You categorize professional contacts for a relationship-first dealmaker (pre-IPO secondaries, lower-middle-market buyouts). " +
      "Categories: family, friend, coworker, investor, vendor, other. " +
      "investor = capital allocators: LPs, family offices, VCs, PE, wealth/asset managers, angels. " +
      "vendor = service providers selling to the user. Use 'other' when unsure. Return JSON only.",
    messages: [
      {
        role: "user",
        content:
          `Assign each contact a category. Return a JSON array of {"id","category"} only.\n` +
          JSON.stringify(batch),
      },
    ],
    maxTokens: 1800,
    temperature: 0,
  });
  try {
    const arr = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
    const out: Record<string, string> = {};
    for (const x of arr) if (x?.id && valid.has(x.category)) out[x.id] = x.category;
    return out;
  } catch {
    return {};
  }
}

/** LinkedIn relations match for one user: fill company/role, flag job changes. */
async function matchLinkedIn(userId: string, list: (typeof contacts.$inferSelect)[]): Promise<void> {
  const li = (
    await db
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, "linkedin")))
      .limit(1)
  )[0];
  if (!li?.externalId || !isConfigured("unipile")) return;

  const relations = await getAllRelations(li.externalId);
  const byUrl = new Map<string, any>();
  const byName = new Map<string, any>();
  for (const r of relations) {
    const url = (r.public_profile_url ?? "").toLowerCase().replace(/\/+$/, "");
    if (url) byUrl.set(url, r);
    const nm = norm(`${r.first_name ?? ""} ${r.last_name ?? ""}`);
    if (nm) byName.set(nm, r);
  }

  let matched = 0;
  for (const c of list) {
    let r: any = null;
    if (c.linkedinUrl) r = byUrl.get(c.linkedinUrl.toLowerCase().replace(/\/+$/, ""));
    if (!r) r = byName.get(norm(c.name));
    if (!r) continue;
    matched++;
    const { title, company } = parseHeadline(r.headline);
    if (company && isRealChange(c.company, company)) {
      await writeClaim({
        contactId: c.id,
        field: "job_change",
        value: `${c.name} appears to have moved from ${c.company} to ${company}`,
        sourceUrl: r.public_profile_url ?? null,
        eventDate: today(),
        publishedDate: today(),
        confidence: 0.7,
      });
    }
    await db
      .update(contacts)
      .set({
        linkedinUrl: c.linkedinUrl ?? r.public_profile_url ?? null,
        company: company ?? c.company,
        role: title ?? c.role,
        isVerifiedPerson: true,
        otherSignals: r.headline ? [r.headline] : c.otherSignals,
        enrichedAt: new Date(),
      })
      .where(eq(contacts.id, c.id));
  }
  console.log(`[enrichment] LinkedIn matched ${matched}/${list.length} for user ${userId}`);
}

/**
 * Enrichment pass. Cheap/bulk first (LinkedIn relations match + categorization),
 * then re-grade, then the rationed paid step (Exa for priority contacts only).
 * Runs nightly and on demand; every integration degrades cleanly when unset.
 */
export async function runEnrichment(): Promise<void> {
  const all = await db.select().from(contacts);
  if (!all.length) return;

  const byUser = new Map<string, (typeof contacts.$inferSelect)[]>();
  for (const c of all) {
    const l = byUser.get(c.userId) ?? [];
    l.push(c);
    byUser.set(c.userId, l);
  }

  // --- Phase A + categorization (cheap) ---
  for (const [userId, list] of byUser) {
    await matchLinkedIn(userId, list);

    const refreshed = await db.select().from(contacts).where(eq(contacts.userId, userId));
    const need = refreshed.filter(
      (c) => (!c.relationship || c.relationship === "other") && (c.company || c.role),
    );
    for (let i = 0; i < need.length && i < 300; i += 50) {
      const slice = need.slice(i, i + 50).map((c) => ({
        id: c.id,
        name: c.name,
        company: c.company,
        role: c.role,
      }));
      const cats = await categorize(slice);
      for (const [id, cat] of Object.entries(cats)) {
        await db
          .update(contacts)
          .set({ relationship: cat as (typeof contacts.$inferInsert)["relationship"] })
          .where(eq(contacts.id, id));
      }
    }
  }

  // --- Re-grade with the freshly filled data + context, so priority is meaningful ---
  await runRecompute();

  // --- Phase C: Exa public milestones for the now-ranked priority set (count-bounded) ---
  if (isConfigured("exa")) {
    const graded = await db.select().from(contacts);
    const priority = graded
      .filter((c) => !c.isOrganization && ((c.relevance ?? 0) >= 55 || c.highValue))
      .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
      .slice(0, 25);
    const startDate = new Date(Date.now() - env.NEWS_FRESHNESS_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    for (const c of priority) {
      const results = await search({
        query: `${c.name} ${c.company ?? ""} funding OR announcement OR appointed OR award`,
        startPublishedDate: startDate,
        numResults: 4,
      });
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
    }
  }

  console.log("[enrichment] pass complete");
}
