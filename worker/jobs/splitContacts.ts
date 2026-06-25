import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { complete } from "@/lib/llm";

type Contact = typeof contacts.$inferSelect;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Strong signals that a single cell holds MORE THAN ONE person.
const NAME_MULTI = /[\n\r]| & | and | \/ |;|\s\|\s|\s\+\s/i;

function emailsIn(s: string | null | undefined): string[] {
  if (!s) return [];
  return [...new Set((s.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))];
}

function isSuspect(c: Contact): boolean {
  if (NAME_MULTI.test(c.name ?? "")) return true;
  if (emailsIn(c.email).length >= 2) return true;
  return false;
}

type Person = { name: string; email: string | null };

async function splitBatch(
  batch: { id: string; name: string; email: string | null; company: string | null }[],
): Promise<Record<string, Person[]>> {
  const raw = await complete({
    tier: "cheap",
    system:
      "Some CRM rows accidentally put MULTIPLE people in one cell (e.g. two colleagues from the same firm on one call). " +
      "For each row return the list of DISTINCT people. Split ONLY when there are genuinely multiple individuals " +
      "(two names like 'Alexia Lingart / Joel Filippi', names on separate lines, or two different email addresses). " +
      "Pair each person with their email when determinable (match the person to the email whose local-part fits their name); otherwise leave email empty. " +
      "NEVER split a single person's first/last name, a single name, or a firm name into multiple people. If it is one person, return exactly one. " +
      'Return ONLY JSON {"items":[{"id":"<id>","people":[{"name":"Full Name","email":"a@b.com"|""}]}]}.',
    messages: [{ role: "user", content: JSON.stringify(batch) }],
    maxTokens: 1500,
    temperature: 0,
  });
  const out: Record<string, Person[]> = {};
  try {
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    for (const it of obj.items ?? []) {
      if (!it?.id || !Array.isArray(it.people)) continue;
      const ppl: Person[] = it.people
        .map((p: { name?: unknown; email?: unknown }) => ({
          name: String(p?.name ?? "").trim(),
          email: String(p?.email ?? "").trim().toLowerCase() || null,
        }))
        .filter((p: Person) => p.name.length > 1);
      if (ppl.length) out[String(it.id)] = ppl;
    }
  } catch {
    /* skip bad batch */
  }
  return out;
}

/**
 * Split contacts whose import lumped multiple people into one cell. Person[0] takes over
 * the original row; the rest become new contacts cloning every shared field (firm, role,
 * notes, derived facets, grade), so two colleagues on one call become two distinct records
 * with identical firm context. Idempotent — single-person rows are never touched.
 */
export async function runSplitContacts(): Promise<void> {
  const all = await db.select().from(contacts);
  const suspects = all.filter((c) => !c.isOrganization && isSuspect(c));
  if (!suspects.length) {
    console.log("[split] no multi-person contacts found");
    return;
  }

  const BATCH = 8;
  const CONCURRENCY = 6;
  const inputs = suspects.map((c) => ({ id: c.id, name: c.name, email: c.email, company: c.company }));
  const batches: (typeof inputs)[] = [];
  for (let i = 0; i < inputs.length; i += BATCH) batches.push(inputs.slice(i, i + BATCH));

  const result: Record<string, Person[]> = {};
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = await Promise.all(batches.slice(i, i + CONCURRENCY).map((b) => splitBatch(b)));
    for (const r of chunk) Object.assign(result, r);
  }

  const byId = new Map(all.map((c) => [c.id, c]));
  let splitRows = 0;
  let created = 0;
  for (const [id, people] of Object.entries(result)) {
    if (people.length < 2) continue;
    const orig = byId.get(id);
    if (!orig) continue;

    // Person[0] takes over the original row (so its history/interactions stay attached).
    await db
      .update(contacts)
      .set({ name: people[0].name, email: people[0].email })
      .where(eq(contacts.id, id));

    // The rest become new contacts cloning all shared firm/context/grade fields.
    for (const p of people.slice(1)) {
      await db.insert(contacts).values({
        userId: orig.userId,
        name: p.name,
        email: p.email,
        company: orig.company,
        role: orig.role,
        location: orig.location,
        industry: orig.industry,
        relationship: orig.relationship,
        customFields: orig.customFields,
        normalizedFields: orig.normalizedFields,
        relevance: orig.relevance,
        professionalFit: orig.professionalFit,
        summary: orig.summary,
        gradeRationale: orig.gradeRationale,
        status: orig.status,
        highValue: orig.highValue,
        replyPropensity: orig.replyPropensity,
        rpFeatures: orig.rpFeatures,
        importPriority: orig.importPriority,
        profileData: orig.profileData,
        gradedAt: orig.gradedAt,
        enrichedAt: orig.enrichedAt,
      });
      created++;
    }
    splitRows++;
  }

  console.log(`[split] split ${splitRows} multi-person row(s); created ${created} new contact(s)`);
}
