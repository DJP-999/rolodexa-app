import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, pitchbookFirms } from "@/db/schema";
import { firmPhrase } from "@/lib/match/entity";

// Friendly label -> PitchBook header(s), in preference order. Captured onto each matched
// contact so the firm's essential intel travels with the rolodex.
const FIELD_MAP: [string, RegExp[], number][] = [
  ["Firm Type", [/^primary investor type$/i, /^investor type$/i], 100],
  ["Description", [/^description$/i], 600],
  ["Year Founded", [/^year founded$/i], 12],
  ["HQ Location", [/^hq location$/i], 100],
  ["Website", [/^website$/i], 120],
  ["Primary Contact", [/^primary contact$/i], 100],
  ["Primary Contact Email", [/^primary contact email$/i], 120],
  ["AUM", [/^aum$/i], 60],
  ["Check Size", [/^preferred deal size$/i, /^preferred investment amount$/i], 80],
  ["Fund Size", [/^median fund size$/i, /^last closed fund size$/i], 60],
  ["Preferred Industry", [/^preferred industry$/i], 240],
  ["Preferred Verticals", [/^preferred verticals?$/i], 240],
  ["Preferred Geography", [/^preferred geography$/i], 160],
  ["Preferred Investment Types", [/^preferred investment types?$/i], 160],
  ["Last Investment", [/^last investment company$/i], 100],
  ["Last Investment Date", [/^last investment date$/i], 40],
  ["Last Investment Type", [/^last investment type$/i], 80],
  ["Last Investment Type 2", [/^last investment type 2$/i], 80],
  ["Last Investment Class", [/^last investment class$/i], 80],
];

/** Pull the essential PitchBook firm fields onto clean labels (matched by exact header). */
function deriveFirmFields(cf: Record<string, string>): Record<string, string> {
  const entries = Object.entries(cf);
  const out: Record<string, string> = {};
  for (const [label, res, cap] of FIELD_MAP) {
    for (const re of res) {
      const hit = entries.find(([k, v]) => v && re.test(k.trim()));
      if (hit) {
        out[label] = hit[1].slice(0, cap);
        break;
      }
    }
  }
  return out;
}

/**
 * Normalize imported PitchBook firms (map their columns to facet fields), then match
 * each contact to a firm by normalized firm name and stash the firm's intel on
 * contact.pitchbookData. Kept entirely separate from the user's own fields.
 */
export async function runPitchbookSync(): Promise<void> {
  const firms = await db.select().from(pitchbookFirms);
  if (!firms.length) {
    console.log("[pitchbook] no firms imported");
    return;
  }

  // 1) Normalize each firm's fields (idempotent rewrite).
  const byUserKey = new Map<string, Record<string, string>>();
  for (const f of firms) {
    const cf = (f.customFields ?? {}) as Record<string, string>;
    const nf = deriveFirmFields(cf);
    if (JSON.stringify(nf) !== JSON.stringify(f.normalizedFields ?? {})) {
      await db.update(pitchbookFirms).set({ normalizedFields: nf }).where(eq(pitchbookFirms.id, f.id));
    }
    byUserKey.set(`${f.userId}:${f.nameKey}`, nf);
  }

  // 2) Match contacts to firms by normalized company name; write pitchbookData.
  const all = await db.select({ id: contacts.id, userId: contacts.userId, company: contacts.company }).from(contacts);
  let matched = 0;
  const updates: { id: string; data: Record<string, string> | null }[] = [];
  for (const c of all) {
    const key = c.company ? `${c.userId}:${firmPhrase(c.company)}` : null;
    const nf = key ? byUserKey.get(key) : undefined;
    updates.push({ id: c.id, data: nf && Object.keys(nf).length ? nf : null });
    if (nf) matched++;
  }
  for (let i = 0; i < updates.length; i += 50) {
    await Promise.all(
      updates
        .slice(i, i + 50)
        .map((u) => db.update(contacts).set({ pitchbookData: u.data }).where(eq(contacts.id, u.id))),
    );
  }
  console.log(`[pitchbook] ${firms.length} firms normalized; matched ${matched} contact(s)`);
}
