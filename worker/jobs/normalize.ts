import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, userContext, users } from "@/db/schema";
import { complete } from "@/lib/llm";

const MAX_COLUMNS = 8;
const MAX_DISTINCT = 120;
const NOTES_BATCH = 8; // contacts per extraction call
const SKIP_HEADER = /email|phone|mobile|cell|url|link|address|street|zip|postal|^id$|date|birthday|website/i;
const NOTES_HEADER = /note|background|summary|description|comment/i;
const TAG_SPLIT = /\s*[\n;|]\s*|\s*,\s+/;

const FIRM_TYPES = [
  "Multi-Family Office",
  "Single-Family Office",
  "RIA / Wealth Manager",
  "Independent Sponsor",
  "Private Credit / Lender",
  "Secondaries Firm",
  "Venture Capital",
  "Private Equity",
  "Fund-of-Funds",
  "Search Fund",
  "Broker / Placement Agent",
  "Endowment / Foundation",
  "Other",
];
/** Bucket a free-form check size ("$1-5M", "$250k", "$1B") into a fixed band. */
function bandCheckSize(raw: string): string {
  const vals: number[] = [];
  const re = /(\d+(?:\.\d+)?)\s*(b(?:illion|n)?|mm?|million|k|thousand)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (!m[1]) continue;
    let n = parseFloat(m[1]);
    const u = (m[2] || "").toLowerCase();
    if (u.startsWith("b")) n *= 1000;
    else if (u.startsWith("k") || u.startsWith("t")) n /= 1000;
    vals.push(n); // m / million / no unit -> millions
  }
  if (!vals.length) return "Unknown";
  const max = Math.max(...vals);
  if (max <= 5) return "< $5M";
  if (max <= 25) return "$5-25M";
  if (max <= 100) return "$25-100M";
  return "$100M+";
}

/** Bucket a free-form region into a fixed set (first match wins, specific before generic). */
function regionBucket(raw: string): string {
  const r = raw.toLowerCase();
  const has = (...ks: string[]) => ks.some((k) => r.includes(k));
  if (has("global", "worldwide", "international")) return "Global";
  if (has("latam", "latin america", "brazil", "mexico", "south america", "argentina", "chile", "colombia"))
    return "LATAM";
  if (has("mena", "middle east", "gcc", "israel", "dubai", "uae", "saudi", "turkey", "qatar")) return "MENA";
  if (has("asia", "india", "japan", "korea", "china", "singapore", "philippines", "vietnam", "indonesia"))
    return "Asia";
  if (has("uk", "united kingdom", "britain", "london", "england")) return "UK";
  if (has("europe", "eu ", " eu", "germany", "france", "spain", "sweden", "italy", "netherlands", "cee", "baltics", "ukraine", "nordic"))
    return "Europe";
  if (has("northeast", "new england", "new york", "boston", "philadelphia", "connecticut")) return "US Northeast";
  if (has("midwest", "chicago", "ohio", "michigan")) return "US Midwest";
  if (has("us west", "silicon valley", "palo alto", "california", "san francisco", "bay area", "seattle", "northwest", "los angeles"))
    return "US West";
  if (has("us south", "southeast", "texas", "florida", "dallas", "atlanta", "miami", "se us")) return "US South";
  if (has("north america", "united states", "u.s", "usa", "us ", "america", "canada", "domestic")) return "North America";
  return "Other";
}

function isCategorical(header: string, values: string[]): boolean {
  if (SKIP_HEADER.test(header) || NOTES_HEADER.test(header)) return false;
  const withValue = values.length;
  if (withValue < 5) return false;
  const distinct = new Set(values.map((v) => v.toLowerCase())).size;
  if (distinct < 2 || distinct > 60) return false;
  if (distinct / withValue >= 0.6) return false;
  if (values.reduce((a, v) => a + v.length, 0) / withValue > 40) return false;
  return true;
}

/** A tag column: values often hold multiple short labels separated by newlines/commas. */
function isTagColumn(header: string, values: string[]): boolean {
  if (SKIP_HEADER.test(header) || NOTES_HEADER.test(header)) return false;
  if (values.length < 5) return false;
  const multi = values.filter((v) => TAG_SPLIT.test(v)).length;
  const short = values.filter((v) => v.length <= 60).length;
  return multi / values.length > 0.15 && short / values.length > 0.5;
}

function splitTags(v: string): string[] {
  return v
    .split(TAG_SPLIT)
    .map((t) => t.trim())
    .filter((t) => t && t.length <= 60);
}

/** LLM clusters messy values into canonical labels. Returns rawLower -> canonical. */
async function clusterValues(header: string, distinct: string[]): Promise<Record<string, string>> {
  const raw = await complete({
    tier: "cheap",
    system:
      "You normalize messy CRM values into clean canonical category labels (Title Case). " +
      "Merge synonyms, abbreviations, casing and spelling variants (e.g. 'MFO','multi family office' -> 'Multi-Family Office'). Do not over-merge distinct things. " +
      'Return ONLY JSON {"map":{"<exact input>":"<Canonical>"}} using the exact inputs as keys.',
    messages: [{ role: "user", content: `Field: ${header}\nValues: ${JSON.stringify(distinct)}` }],
    maxTokens: 1500,
    temperature: 0,
  });
  try {
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    const m = obj.map ?? obj;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m)) if (typeof v === "string" && v.trim()) out[k.toLowerCase().trim()] = v.trim();
    return out;
  } catch {
    return {};
  }
}

/** Extract a canonical Firm Type, Check Size, and Region from each contact's notes. */
async function extractFromNotes(
  batch: { id: string; notes: string }[],
): Promise<Record<string, { firmType?: string; checkSize?: string; region?: string }>> {
  const raw = await complete({
    tier: "cheap",
    system:
      "You read short notes about an investor/firm and extract structured facts. For each item return: " +
      `firmType (one of: ${FIRM_TYPES.join(", ")}), ` +
      "checkSize (their typical check size exactly as stated, e.g. '$1-5M', '$250k', '$25M', or 'Unknown'), " +
      "and region (their geographic focus as stated, e.g. 'US Northeast', 'Europe', 'LATAM', 'Global'). " +
      "Infer only from the text; use 'Other'/'Unknown' when not stated. " +
      'Return ONLY JSON {"items":[{"id":"<id>","firmType":"...","checkSize":"...","region":"..."}]}.',
    messages: [
      {
        role: "user",
        content: JSON.stringify(batch.map((b) => ({ id: b.id, notes: b.notes.slice(0, 500) }))),
      },
    ],
    maxTokens: 1200,
    temperature: 0,
  });
  const out: Record<string, { firmType?: string; checkSize?: string; region?: string }> = {};
  try {
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    for (const it of obj.items ?? []) {
      if (it?.id) out[String(it.id)] = { firmType: it.firmType, checkSize: it.checkSize, region: it.region };
    }
  } catch {
    /* skip */
  }
  return out;
}

export async function runNormalize(): Promise<void> {
  const us = await db.select().from(users);
  for (const u of us) {
    const rows = await db
      .select({ id: contacts.id, customFields: contacts.customFields })
      .from(contacts)
      .where(eq(contacts.userId, u.id));
    if (!rows.length) continue;

    const byCol = new Map<string, string[]>();
    let notesHeader: string | null = null;
    for (const r of rows) {
      const cf = (r.customFields ?? {}) as Record<string, string>;
      for (const [k, v] of Object.entries(cf)) {
        if (!v) continue;
        const list = byCol.get(k) ?? [];
        list.push(v);
        byCol.set(k, list);
        if (!notesHeader && NOTES_HEADER.test(k) && v.length > 60) notesHeader = k;
      }
    }

    const groupings: Record<string, { label: string; categories: string[]; multi?: boolean }> = {};
    const singleMap: Record<string, Record<string, string>> = {};
    const tagMap: Record<string, Record<string, string>> = {};

    let used = 0;
    for (const [header, values] of byCol) {
      if (used >= MAX_COLUMNS) break;
      if (isTagColumn(header, values)) {
        const tags = [...new Set(values.flatMap(splitTags))].slice(0, MAX_DISTINCT);
        const map = await clusterValues(header, tags);
        if (Object.keys(map).length) {
          tagMap[header] = map;
          groupings[header] = { label: header, categories: [...new Set(Object.values(map))].sort(), multi: true };
          used++;
        }
      } else if (isCategorical(header, values)) {
        const distinct = [...new Set(values)].slice(0, MAX_DISTINCT);
        const map = await clusterValues(header, distinct);
        if (Object.keys(map).length) {
          singleMap[header] = map;
          groupings[header] = { label: header, categories: [...new Set(Object.values(map))].sort() };
          used++;
        }
      }
    }

    // Derived facets from notes.
    const derived: Record<string, { firmType?: string; checkSize?: string; region?: string }> = {};
    if (notesHeader) {
      const withNotes = rows
        .map((r) => ({ id: r.id, notes: ((r.customFields ?? {}) as Record<string, string>)[notesHeader!] ?? "" }))
        .filter((x) => x.notes && x.notes.length > 40);
      const batches: { id: string; notes: string }[][] = [];
      for (let i = 0; i < withNotes.length; i += NOTES_BATCH) batches.push(withNotes.slice(i, i + NOTES_BATCH));
      // Run batches concurrently so ~1,000 notes take ~1 minute, not ten.
      const CONCURRENCY = 10;
      for (let i = 0; i < batches.length; i += CONCURRENCY) {
        const results = await Promise.all(batches.slice(i, i + CONCURRENCY).map((b) => extractFromNotes(b)));
        for (const res of results) Object.assign(derived, res);
      }
      // Collapse check size + region into fixed buckets so the facets stay clean.
      for (const v of Object.values(derived)) {
        if (v.checkSize) v.checkSize = bandCheckSize(v.checkSize);
        if (v.region) v.region = regionBucket(v.region);
      }
      const firmCats = new Set<string>();
      const sizeCats = new Set<string>();
      const regionCats = new Set<string>();
      for (const v of Object.values(derived)) {
        if (v.firmType) firmCats.add(v.firmType);
        if (v.checkSize) sizeCats.add(v.checkSize);
        if (v.region) regionCats.add(v.region);
      }
      if (firmCats.size) groupings["Firm Type"] = { label: "Firm Type", categories: [...firmCats].sort() };
      if (sizeCats.size) groupings["Check Size"] = { label: "Check Size", categories: [...sizeCats].sort() };
      if (regionCats.size) groupings["Region"] = { label: "Region", categories: [...regionCats].sort() };
    }

    if (!Object.keys(groupings).length) {
      console.log(`[normalize] nothing to group for ${u.email}`);
      continue;
    }

    // Apply per contact, in parallel chunks.
    const updates: { id: string; normalizedFields: Record<string, string> }[] = [];
    for (const r of rows) {
      const cf = (r.customFields ?? {}) as Record<string, string>;
      const norm: Record<string, string> = {};
      for (const header of Object.keys(singleMap)) {
        const c = singleMap[header][(cf[header] ?? "").toLowerCase().trim()];
        if (c) norm[header] = c;
      }
      for (const header of Object.keys(tagMap)) {
        const raw = cf[header];
        if (!raw) continue;
        const tags = [...new Set(splitTags(raw).map((t) => tagMap[header][t.toLowerCase().trim()]).filter(Boolean))];
        if (tags.length) norm[header] = tags.join(" | ");
      }
      const d = derived[r.id];
      if (d?.firmType) norm["Firm Type"] = d.firmType;
      if (d?.checkSize) norm["Check Size"] = d.checkSize;
      if (d?.region) norm["Region"] = d.region;
      if (Object.keys(norm).length) updates.push({ id: r.id, normalizedFields: norm });
    }
    for (let i = 0; i < updates.length; i += 50) {
      await Promise.all(
        updates
          .slice(i, i + 50)
          .map((up) => db.update(contacts).set({ normalizedFields: up.normalizedFields }).where(eq(contacts.id, up.id))),
      );
    }

    await db
      .insert(userContext)
      .values({ userId: u.id, fieldGroupings: groupings })
      .onConflictDoUpdate({ target: userContext.userId, set: { fieldGroupings: groupings } });

    console.log(
      `[normalize] ${u.email}: ${Object.keys(groupings).length} facet(s), applied to ${updates.length} contact(s)`,
    );
  }
}
