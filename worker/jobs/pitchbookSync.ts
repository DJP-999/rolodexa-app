import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, pitchbookFirms } from "@/db/schema";
import { firmPhrase } from "@/lib/match/entity";

/** Map a PitchBook firm's raw columns onto the same facet keys the contacts UI uses. */
function deriveFirmFields(cf: Record<string, string>): Record<string, string> {
  const entries = Object.entries(cf);
  const pick = (res: RegExp[]): string | undefined => {
    for (const re of res) {
      const hit = entries.find(([k, v]) => v && re.test(k));
      if (hit) return hit[1];
    }
    return undefined;
  };
  const out: Record<string, string> = {};
  const firmType = pick([/^primary investor type$/i, /primary investor type/i, /investor type/i, /\bfirm type\b/i]);
  const region = pick([/^hq location$/i, /hq location/i, /preferred geograph/i, /hq country/i, /\bregion\b/i, /\blocation\b/i]);
  const sectors = pick([/preferred industr/i, /preferred vertical/i, /^all industries$/i, /^verticals$/i, /industr/i, /vertical/i]);
  const check = pick([/^preferred deal size$/i, /preferred deal size\b/i, /^preferred ebitda$/i, /preferred ebitda\b/i, /deal size/i, /investment size/i]);
  const fund = pick([/median fund size/i, /last closed fund size/i, /max fund size/i, /fund size/i, /dry powder/i]);
  const aum = pick([/^aum$/i, /\baum\b/i, /assets under management/i]);
  const desc = pick([/^description$/i, /description/i]);
  if (firmType) out["Firm Type"] = firmType.slice(0, 80);
  if (region) out["Region"] = region.slice(0, 80);
  if (sectors) out["Interests"] = sectors.slice(0, 200);
  if (check) out["Check Size"] = check.slice(0, 80);
  if (fund) out["Fund Size"] = fund.slice(0, 80);
  if (aum) out["AUM"] = aum.slice(0, 80);
  // Description is rich firm context for the fit grader; it has no contact column, so it
  // won't render in the table — it only enriches grading.
  if (desc) out["Description"] = desc.slice(0, 320);
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
