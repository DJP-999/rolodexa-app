import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, userContext, users } from "@/db/schema";
import { complete } from "@/lib/llm";

const MAX_COLUMNS = 8; // bound LLM cost: only the most category-like columns per user
const MAX_DISTINCT = 80; // values sent to the model for one column
const SKIP_HEADER = /note|email|phone|mobile|cell|url|link|address|street|zip|postal|^id$|date|birthday|website|notes|comment|description/i;

/** Heuristic: does this column hold a small set of repeated, short, category-like values? */
function isCategorical(header: string, values: string[]): boolean {
  if (SKIP_HEADER.test(header)) return false;
  const withValue = values.length;
  if (withValue < 5) return false;
  const distinct = new Set(values.map((v) => v.toLowerCase())).size;
  if (distinct < 2 || distinct > 60) return false;
  if (distinct / withValue >= 0.6) return false; // too unique -> free text / ids
  const avgLen = values.reduce((a, v) => a + v.length, 0) / withValue;
  if (avgLen > 40) return false; // long text -> notes
  const urlish = values.filter((v) => /@|https?:|www\.|\d{5,}/.test(v)).length;
  if (urlish / withValue > 0.3) return false;
  return true;
}

/** Ask the model to merge messy variants into canonical category labels. Returns rawLower -> canonical. */
async function clusterColumn(header: string, distinct: string[]): Promise<Record<string, string>> {
  const raw = await complete({
    tier: "cheap",
    system:
      "You normalize messy CRM column values into clean canonical categories. " +
      "Map each given value to a canonical category label in Title Case. " +
      "Merge synonyms, abbreviations, casing, and spelling variants (e.g. 'MFO', 'multi family office', 'multi-family office' all map to 'Multi-Family Office'). " +
      "Do NOT over-merge genuinely different things. Keep the label concise and human. " +
      'Return ONLY JSON: {"map": {"<exact input value>": "<Canonical Label>", ...}} using the exact input strings as keys.',
    messages: [
      {
        role: "user",
        content: `Column: ${header}\nValues: ${JSON.stringify(distinct)}`,
      },
    ],
    maxTokens: 1500,
    temperature: 0,
  });
  try {
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    const m = obj.map ?? obj;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === "string" && v.trim()) out[k.toLowerCase().trim()] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Auto-group categorical custom columns into canonical categories so the contacts
 * table is filterable/searchable on clean, verifiable data. Auto-applies the grouping
 * (stores a canonical value per contact + the category list for facets).
 */
export async function runNormalize(): Promise<void> {
  const us = await db.select().from(users);
  for (const u of us) {
    const rows = await db
      .select({ id: contacts.id, customFields: contacts.customFields })
      .from(contacts)
      .where(eq(contacts.userId, u.id));
    if (!rows.length) continue;

    // Collect values per column.
    const byCol = new Map<string, string[]>();
    for (const r of rows) {
      const cf = (r.customFields ?? {}) as Record<string, string>;
      for (const [k, v] of Object.entries(cf)) {
        if (!v) continue;
        const list = byCol.get(k) ?? [];
        list.push(v);
        byCol.set(k, list);
      }
    }

    // Pick the most category-like columns (most repetition wins), capped for cost.
    const categorical = [...byCol.entries()]
      .filter(([header, values]) => isCategorical(header, values))
      .sort((a, b) => new Set(a[1].map((v) => v.toLowerCase())).size - new Set(b[1].map((v) => v.toLowerCase())).size)
      .slice(0, MAX_COLUMNS);

    const groupings: Record<string, { label: string; categories: string[] }> = {};
    const colMaps: Record<string, Record<string, string>> = {};

    for (const [header, values] of categorical) {
      const distinct = [...new Set(values)].slice(0, MAX_DISTINCT);
      const map = await clusterColumn(header, distinct);
      if (!Object.keys(map).length) continue;
      colMaps[header] = map;
      groupings[header] = { label: header, categories: [...new Set(Object.values(map))].sort() };
    }

    if (!Object.keys(groupings).length) {
      console.log(`[normalize] no categorical columns for ${u.email}`);
      continue;
    }

    // Apply: write a canonical value per contact for each normalized column.
    let updated = 0;
    for (const r of rows) {
      const cf = (r.customFields ?? {}) as Record<string, string>;
      const norm: Record<string, string> = {};
      for (const header of Object.keys(groupings)) {
        const rawVal = cf[header];
        if (!rawVal) continue;
        const canonical = colMaps[header][rawVal.toLowerCase().trim()];
        if (canonical) norm[header] = canonical;
      }
      if (Object.keys(norm).length) {
        await db.update(contacts).set({ normalizedFields: norm }).where(eq(contacts.id, r.id));
        updated++;
      }
    }

    await db
      .insert(userContext)
      .values({ userId: u.id, fieldGroupings: groupings })
      .onConflictDoUpdate({ target: userContext.userId, set: { fieldGroupings: groupings } });

    console.log(
      `[normalize] ${u.email}: grouped ${Object.keys(groupings).length} column(s), applied to ${updated} contact(s)`,
    );
  }
}
