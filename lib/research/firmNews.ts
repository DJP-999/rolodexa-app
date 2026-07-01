import { inArray, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, firmNews, firmWatch } from "@/db/schema";
import { env, isConfigured } from "@/lib/env";
import { search as exaSearch } from "@/lib/integrations/exa";
import { firmPhrase, flatten } from "@/lib/match/entity";
import { writeClaim } from "@/lib/provenance/claims";
import { complete } from "@/lib/llm";
import { firmKey } from "./firm";

type Contact = typeof contacts.$inferSelect;

/**
 * FIRM-CENTRIC news engine — constantly track the firms that MATTER TO THE USER'S GOALS.
 *
 * The old model searched firm news once per CONTACT (5 contacts at one firm = 5 identical
 * Exa searches; firms of lower-ranked contacts never got checked at all). This engine inverts
 * it: ONE categorized search per distinct goal-relevant FIRM, rotated stalest-first so that
 * watched universe is swept every couple of days, results stored durably in firm_news, and
 * each item fanned out as a sourced claim to the goal-relevant contacts there — which the
 * suggestion engine turns into angle-aware outreach. Which firms qualify is derived from the
 * user's OWN settings (professionalFit is graded against their role/focus), so the engine is
 * profession-agnostic: allocator firms for a fundraiser, client firms for a recruiter, etc.
 */

// Generic across every line of work: a "firm" is wherever the contact works — a fund, a SaaS
// company, a hospital system, a law firm, an agency. Categories are business-event shaped, not
// finance-shaped; "funding" covers a startup's Series B and a GP's fund close equally.
export const FIRM_NEWS_CATEGORIES = [
  "funding", // raised capital / closed a round or fund
  "deal", // made an investment, acquisition, merger, exit, or major sale
  "launch", // launched a product, service, strategy, or initiative
  "partnership", // strategic partnership or major client/customer win
  "expansion", // new office, market, or significant team growth
  "leadership", // senior leadership change
  "setback", // layoffs, closures, losses — a supportive check-in, never a congrats
  "other",
] as const;
export type FirmNewsCategory = (typeof FIRM_NEWS_CATEGORIES)[number];

/** Human phrasing per category so drafts can play the right angle without another LLM call. */
export const CATEGORY_ANGLE: Record<string, string> = {
  funding: "Their organization just raised/closed capital — real momentum worth congratulating.",
  deal: "Their organization just did a deal (investment, acquisition, or exit) — a natural opener.",
  launch: "Their organization just launched something — react to it with genuine interest.",
  partnership: "Their organization landed a partnership or major win — congratulate the momentum.",
  expansion: "Their organization is expanding — a good, timely excuse to check in.",
  leadership: "Leadership news at their organization — relevant to their world.",
  setback: "Their organization hit a rough patch — check in with genuine support, never congratulate.",
  other: "Noteworthy news at their organization — acknowledge it naturally.",
};

/** Word-bounded exact-firm check (same precision bar as mentionsContact, firm-only). */
function mentionsFirm(name: string, text: string): boolean {
  const firm = firmPhrase(name);
  if (!firm) return false;
  const tokens = firm.split(" ").filter(Boolean);
  const distinct = tokens.length >= 2 || firm.length >= 7;
  if (!distinct) return false;
  return ` ${flatten(text || "")} `.includes(` ${firm} `);
}

/** Parse "YYYY[-MM[-DD]]" into ISO + age in days, else null. */
function parseDate(s: unknown): { iso: string; ageDays: number } | null {
  if (typeof s !== "string" || !s.trim()) return null;
  const t = s.trim();
  const full = /^\d{4}$/.test(t) ? `${t}-01-01` : /^\d{4}-\d{2}$/.test(t) ? `${t}-01` : t;
  const d = new Date(full);
  if (isNaN(d.getTime())) return null;
  return { iso: d.toISOString().slice(0, 10), ageDays: (Date.now() - d.getTime()) / 86_400_000 };
}

type FirmGroup = { name: string; contacts: Contact[]; best: number };

/** Score used to prioritize which firm's contacts matter most. */
function contactScore(c: Contact): number {
  return Math.max(c.professionalFit ?? 0, (c.relevance ?? 0) / 100) + (c.highValue ? 0.5 : 0);
}

/**
 * True when a contact clears the user's goal-relevance bar — the SAME floor the news sweep
 * uses. professionalFit is graded against each user's own role/focus from Settings, so this
 * stays generic across professions: an IR user's floor selects allocators, a recruiter's
 * selects client/candidate firms, a founder's selects customers and investors.
 */
function clearsGoalFloor(c: Contact): boolean {
  return Boolean(
    c.highValue || (c.professionalFit ?? 0) >= env.NEWS_FIT_FLOOR || (c.relevance ?? 0) >= 50,
  );
}

/**
 * Group the rolodex into distinct firms worth CONSTANTLY watching: only firms where at least
 * one contact is genuinely relevant to the user's settings/goals (VIP, thesis-fit, or high
 * relevance). Everything else is deliberately not watched — coverage should be dense on the
 * network that matters, not diluted across noisy imports.
 */
function groupFirms(all: Contact[]): Map<string, FirmGroup> {
  const groups = new Map<string, FirmGroup>();
  for (const c of all) {
    if (c.isOrganization || !c.company) continue;
    const key = firmKey(c.company);
    if (!key || key.length < 3) continue;
    const g = groups.get(key) ?? { name: c.company, contacts: [], best: 0 };
    g.contacts.push(c);
    g.best = Math.max(g.best, contactScore(c));
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    if (!g.contacts.some(clearsGoalFloor)) groups.delete(key);
  }
  return groups;
}

/** Validate + categorize Exa results for one firm with a single cheap LLM read. */
async function extractFirmNews(
  name: string,
  results: { title?: string; url: string; publishedDate?: string; text?: string; highlights?: string[] }[],
  windowDays: number,
): Promise<{ headline: string; url: string; eventDate: string; category: FirmNewsCategory }[]> {
  // Deterministic guard first: the result must actually name this exact firm.
  const candidates = results.filter((r) =>
    mentionsFirm(name, `${r.title ?? ""} ${r.text ?? ""} ${(r.highlights ?? []).join(" ")} ${r.url}`),
  );
  if (!candidates.length) return [];
  const payload = candidates.map((r, i) => ({
    i,
    title: r.title ?? "",
    url: r.url,
    publishedDate: r.publishedDate ?? null,
    snippet: (r.text ?? r.highlights?.[0] ?? "").slice(0, 300),
  }));
  const raw = await complete({
    tier: "cheap",
    system:
      "You validate web results about a specific ORGANIZATION (any kind — a company, fund, firm, hospital, agency, nonprofit) for a relationship intelligence system. For each result decide: " +
      "(1) is it genuinely about THIS exact organization — not a different one that shares a word or partial name (be strict; when unsure, mark false); " +
      "(2) does it report a NOTEWORTHY, RECENT event someone who knows an employee there would plausibly text them about: raised/closed capital, a deal (investment, acquisition, merger, exit, major sale), a launch, a strategic partnership or major win, an expansion, a senior leadership change, or a significant setback (layoffs, closure). Routine PR, product blogspam, listicles, and stale roundups do NOT count. " +
      `(3) categorize it as exactly one of: ${FIRM_NEWS_CATEGORIES.join(", ")}. ` +
      "(4) give the EVENT date if stated (not the page date). " +
      "Write the headline as ONE factual sentence that names the organization. Return JSON only.",
    messages: [
      {
        role: "user",
        content:
          `Firm: ${name}\nResults: ${JSON.stringify(payload)}\n` +
          `Return a JSON array [{"i":number,"about_this_firm":boolean,"noteworthy":boolean,"category":"${FIRM_NEWS_CATEGORIES.join('"|"')}","event_date":"YYYY-MM-DD"|null,"headline":"one factual sentence naming the firm"}].`,
      },
    ],
    maxTokens: 800,
    temperature: 0,
  });
  try {
    const arr = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
    const out: { headline: string; url: string; eventDate: string; category: FirmNewsCategory }[] = [];
    for (const x of arr) {
      if (!(x?.about_this_firm && x?.noteworthy && typeof x.i === "number" && candidates[x.i])) continue;
      const r = candidates[x.i];
      const dated = parseDate(x.event_date) ?? parseDate(r.publishedDate);
      if (!dated || dated.ageDays < 0 || dated.ageDays > windowDays) continue; // recency gate
      const category = (FIRM_NEWS_CATEGORIES as readonly string[]).includes(String(x.category))
        ? (String(x.category) as FirmNewsCategory)
        : "other";
      out.push({ headline: String(x.headline || r.title || r.url), url: r.url, eventDate: dated.iso, category });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * One sweep: pick the stalest FIRM_NEWS_BATCH firms, search each once, store validated items,
 * and fan each item out as a claim to the top contacts at that firm. Returns counts for logs.
 */
export async function sweepFirmNews(
  onProgress?: (done: number, total: number) => void,
): Promise<{ firms: number; items: number; claimsWritten: number }> {
  if (!isConfigured("exa")) return { firms: 0, items: 0, claimsWritten: 0 };
  const all = await db.select().from(contacts);
  const groups = groupFirms(all);
  if (!groups.size) return { firms: 0, items: 0, claimsWritten: 0 };

  // Ensure a watch row exists for every wanted firm (idempotent).
  const keys = [...groups.keys()];
  for (let i = 0; i < keys.length; i += 200) {
    const slice = keys.slice(i, i + 200);
    await db
      .insert(firmWatch)
      .values(slice.map((k) => ({ nameKey: k, name: groups.get(k)!.name })))
      .onConflictDoNothing();
  }

  // Rotation: never-checked first, then oldest-checked; tiebreak by strongest contact.
  const watch: (typeof firmWatch.$inferSelect)[] = [];
  for (let i = 0; i < keys.length; i += 200) {
    watch.push(...(await db.select().from(firmWatch).where(inArray(firmWatch.nameKey, keys.slice(i, i + 200)))));
  }
  watch.sort((a, b) => {
    const at = a.newsCheckedAt ? new Date(a.newsCheckedAt).getTime() : 0;
    const bt = b.newsCheckedAt ? new Date(b.newsCheckedAt).getTime() : 0;
    if (at !== bt) return at - bt;
    return (groups.get(b.nameKey)?.best ?? 0) - (groups.get(a.nameKey)?.best ?? 0);
  });
  const batch = watch.slice(0, env.FIRM_NEWS_BATCH);

  const windowDays = env.FIRM_NEWS_WINDOW_DAYS;
  const startDate = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
  let items = 0;
  let claimsWritten = 0;
  let done = 0;
  if (batch.length) onProgress?.(0, batch.length);

  for (const w of batch) {
    const g = groups.get(w.nameKey);
    if (!g) continue;
    try {
      // Generic business-event query — works for a PE fund, a SaaS vendor, a hospital system,
      // or a law firm alike; the validator categorizes and the user's own goals shape ranking.
      const hits = await exaSearch({
        query: `"${g.name}" (raises OR funding OR closes OR acquires OR acquisition OR merger OR investment OR launches OR launch OR partnership OR partners OR expands OR expansion OR opens OR appoints OR hires OR layoffs OR IPO OR exit OR milestone OR announces)`,
        startPublishedDate: startDate,
        numResults: 6,
      });
      const validated = await extractFirmNews(g.name, hits, windowDays);
      for (const v of validated) {
        await db
          .insert(firmNews)
          .values({ nameKey: w.nameKey, name: g.name, headline: v.headline, category: v.category, url: v.url, eventDate: v.eventDate })
          .onConflictDoNothing();
        items++;
        // Fan out ONLY to contacts who themselves clear the goal floor (a qualifying firm can
        // still employ low-relevance contacts), top-N by VIP/fit/relevance — a claim per
        // contact keeps the existing provenance→suggestion→Telegram path untouched.
        const targets = g.contacts
          .filter(clearsGoalFloor)
          .sort((a, b) => contactScore(b) - contactScore(a))
          .slice(0, env.FIRM_NEWS_FANOUT);
        for (const c of targets) {
          await writeClaim({
            contactId: c.id,
            field: "news",
            value: v.headline,
            sourceUrl: v.url,
            eventDate: v.eventDate,
            publishedDate: v.eventDate,
            confidence: 0.7,
          });
          claimsWritten++;
        }
      }
    } catch (e) {
      console.error(`[firm-news] sweep failed for ${g.name}`, e);
    }
    await db.update(firmWatch).set({ newsCheckedAt: new Date() }).where(eq(firmWatch.id, w.id));
    done++;
    onProgress?.(done, batch.length);
  }
  return { firms: batch.length, items, claimsWritten };
}

/** Latest stored news for one firm (for the contact page / future firm view). */
export async function newsForFirm(company: string, limit = 8) {
  const key = firmKey(company);
  if (!key) return [];
  return db.select().from(firmNews).where(eq(firmNews.nameKey, key)).orderBy(desc(firmNews.eventDate)).limit(limit);
}
