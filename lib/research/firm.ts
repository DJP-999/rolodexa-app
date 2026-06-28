import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { firmResearch } from "@/db/schema";
import { search as exaSearch } from "@/lib/integrations/exa";
import { complete } from "@/lib/llm";

/**
 * Cached, web-sourced firm intel for fit grading. For each distinct firm we run an Exa
 * search and distill a tight factual brief (type, strategy, stage/asset class, notable
 * holdings, AUM), then cache it GLOBALLY by normalized name — so a firm is researched once
 * and reused for every contact who works there, across runs. This is what lets a niche but
 * on-thesis firm (a small VC, family office, or secondaries shop) be graded on real facts
 * instead of the model's thin priors about an unfamiliar name.
 */

// Firms change slowly; re-research roughly quarterly. A negative result (no summary) is also
// cached so we don't re-hit Exa every run for an un-findable name until the window passes.
const FRESH_MS = 120 * 24 * 60 * 60 * 1000;

/** Normalized firm key: keep the real words (so "Plexo Capital" ≠ "Plexo"), drop punctuation. */
export function firmKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function fresh(updatedAt: Date | string): boolean {
  return Date.now() - new Date(updatedAt).getTime() < FRESH_MS;
}

/** Search + distill one firm into a brief. Returns null when nothing usable is found. */
async function summarizeFirm(name: string): Promise<string | null> {
  let results;
  try {
    results = await exaSearch({
      query: `${name} investment firm — strategy, stage focus, asset class, portfolio companies, assets under management`,
      numResults: 6,
    });
  } catch (e) {
    console.error("[firm-research] exa", e);
    return null;
  }
  if (!results.length) return null;
  const corpus = results
    .map((r) => `# ${r.title ?? ""} (${r.url})\n${(r.text ?? r.highlights?.join(" ") ?? "").slice(0, 1200)}`)
    .join("\n\n")
    .slice(0, 6000);
  const raw = await complete({
    tier: "cheap",
    system:
      "You distill web results about a finance/investment firm into a tight factual brief for a dealmaker. 4-6 sentences, dense, no fluff. Cover, in order: (1) what the firm IS — its type (VC, growth, buyout PE, family office, fund-of-funds, secondaries, private credit, hedge fund, placement agent, etc.); (2) its strategy and the SPECIFIC stage and asset class it invests in (e.g. early-stage venture equity vs late-stage/pre-IPO vs buyout vs LP fund stakes vs credit); (3) notable portfolio companies or holdings; (4) approximate AUM or fund size; (5) anything distinctive. If the results clearly describe a DIFFERENT firm that merely shares the name, say which facts are uncertain and report ONLY what is confidently about this firm. Never invent facts; if something isn't in the results, omit it.",
    messages: [{ role: "user", content: `Firm: ${name}\n\nWeb results:\n${corpus}` }],
    maxTokens: 400,
    temperature: 0,
  });
  const t = raw.trim();
  return t && !t.startsWith("[llm-stub") ? t.slice(0, 1400) : null;
}

/** Research a single firm (cache-first). Returns the brief, or null if none could be built. */
export async function researchFirm(name: string): Promise<string | null> {
  const nk = firmKey(name);
  if (!nk) return null;
  try {
    const existing = (await db.select().from(firmResearch).where(eq(firmResearch.nameKey, nk)).limit(1))[0];
    if (existing && fresh(existing.updatedAt)) return existing.summary ?? null;
    const summary = await summarizeFirm(name);
    await db
      .insert(firmResearch)
      .values({ nameKey: nk, name, summary })
      .onConflictDoUpdate({ target: firmResearch.nameKey, set: { name, summary, updatedAt: new Date() } });
    return summary;
  } catch (e) {
    console.error("[firm-research] researchFirm", e);
    return null;
  }
}

/**
 * Research many firms at once, cache-first and BUDGET-BOUNDED: already-cached fresh firms are
 * free; only up to `cap` uncached firms are researched this run (the rest converge on later
 * runs as the cache fills). Returns a map of normalized-key → brief for everything available.
 */
export async function researchFirms(
  names: string[],
  cap: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = new Map<string, string>(); // key → a display name
  for (const n of names) {
    const k = firmKey(n ?? "");
    if (k && !wanted.has(k)) wanted.set(k, n);
  }
  if (!wanted.size) return out;

  const keys = [...wanted.keys()];
  const cached = new Map<string, typeof firmResearch.$inferSelect>();
  try {
    for (let i = 0; i < keys.length; i += 200) {
      const rows = await db.select().from(firmResearch).where(inArray(firmResearch.nameKey, keys.slice(i, i + 200)));
      for (const r of rows) cached.set(r.nameKey, r);
    }
  } catch (e) {
    console.error("[firm-research] preload", e);
  }

  // Serve cached-fresh firms for free; queue the rest up to the budget.
  const toResearch: Array<{ k: string; name: string }> = [];
  let budget = Math.max(0, cap);
  for (const [k, name] of wanted) {
    const c = cached.get(k);
    if (c && fresh(c.updatedAt)) {
      if (c.summary) out.set(k, c.summary);
      continue;
    }
    if (budget <= 0) continue; // leave for the next run; the cache converges
    budget--;
    toResearch.push({ k, name });
  }

  // Research the queue with a small worker pool (bounded so Exa isn't hammered).
  const CONCURRENCY = 4;
  const total = toResearch.length;
  let cursor = 0;
  let done = 0;
  if (total > 0) onProgress?.(0, total);
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, total) }, async () => {
      while (cursor < toResearch.length) {
        const item = toResearch[cursor++];
        const s = await researchFirm(item.name);
        if (s) out.set(item.k, s);
        done++;
        if (total > 0) onProgress?.(done, total);
      }
    }),
  );
  return out;
}
