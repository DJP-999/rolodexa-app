import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { complete } from "@/lib/llm";

type Extracted = {
  location?: string | null;
  relationship?: string | null;
  company?: string | null;
  role?: string | null;
  industry?: string | null;
  sectors?: string[];
  portfolio?: string[];
  targets?: string[];
  dealStructure?: string | null;
  summary?: string | null;
};

const RELS = new Set(["investor", "friend", "coworker", "vendor", "family", "other"]);

/** Turn a dealmaker's freeform meeting notes about one person/firm into structured fields. */
export async function interpretMeetingNotes(notes: string): Promise<Extracted | null> {
  const text = notes.trim();
  if (!text) return null;
  const out = await complete({
    tier: "strong",
    system:
      "You convert a dealmaker's raw meeting notes about ONE person or firm into structured JSON. " +
      "Use ONLY facts stated in the notes — never invent or infer beyond what's written. Leave fields null/empty " +
      "when not stated. Return STRICT JSON only (no prose), with this exact shape: " +
      '{"location":string|null,"relationship":"investor"|"friend"|"coworker"|"vendor"|"family"|"other"|null,' +
      '"company":string|null,"role":string|null,"industry":string|null,"sectors":string[],"portfolio":string[],' +
      '"targets":string[],"dealStructure":string|null,"summary":string}. ' +
      "Definitions: industry = the firm type (e.g. 'Venture Capital'); sectors = focus areas/verticals; " +
      "portfolio = companies they have invested in; targets = companies or people they want to meet or invest in; " +
      "dealStructure = how they invest or structure deals (e.g. SPVs, L1 vehicles, direct); " +
      "summary = a 1–2 sentence synthesis. relationship = best single category for this person.",
    messages: [{ role: "user", content: `Notes:\n${text}\n\nJSON:` }],
    maxTokens: 600,
    temperature: 0,
  });
  if (!out || out.startsWith("[llm-stub")) return null;
  try {
    const m = out.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as Extracted;
  } catch {
    /* ignore */
  }
  return null;
}

function joinList(a?: string[]): string {
  return (a ?? []).filter((x) => typeof x === "string" && x.trim()).join(", ");
}

/**
 * Interpret meeting notes and file them onto the contact. Fills empty core fields and
 * adds categorized custom fields — never overwriting data the user set themselves.
 */
export async function applyMeetingNotes(contactId: string, notes: string): Promise<void> {
  const c = (await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1))[0];
  if (!c) return;
  const ex = await interpretMeetingNotes(notes);

  const cf = { ...((c.customFields ?? {}) as Record<string, string>) };
  cf["Meeting Notes"] = notes.slice(0, 2000);

  const upd: Partial<typeof contacts.$inferInsert> = {};
  if (ex) {
    if (ex.location && !c.location) upd.location = ex.location.slice(0, 120);
    if (ex.company && !c.company) upd.company = ex.company.slice(0, 160);
    if (ex.role && !c.role) upd.role = ex.role.slice(0, 160);
    if (ex.industry && !c.industry) upd.industry = ex.industry.slice(0, 120);
    if (ex.relationship && RELS.has(ex.relationship) && (!c.relationship || c.relationship === "other"))
      upd.relationship = ex.relationship as typeof contacts.$inferInsert["relationship"];
    if (ex.summary && !c.summary) upd.summary = ex.summary.slice(0, 600);
    const sectors = joinList(ex.sectors);
    const portfolio = joinList(ex.portfolio);
    const targets = joinList(ex.targets);
    if (sectors) cf["Sectors"] = sectors.slice(0, 500);
    if (portfolio) cf["Portfolio"] = portfolio.slice(0, 500);
    if (targets) cf["Targets"] = targets.slice(0, 500);
    if (ex.dealStructure) cf["Deal Structure"] = ex.dealStructure.slice(0, 300);
  }
  upd.customFields = cf;
  await db.update(contacts).set(upd).where(eq(contacts.id, contactId));
}
