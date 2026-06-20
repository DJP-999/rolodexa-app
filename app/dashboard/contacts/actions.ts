"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import Papa from "papaparse";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { isConfigured } from "@/lib/env";
import { extractJSON } from "@/lib/llm";
import { getPrimaryUser } from "@/lib/user";
import { enqueue, runOnce } from "@/worker/scheduler";

type Rel = "family" | "friend" | "coworker" | "investor" | "vendor" | "other";
type NewContact = typeof contacts.$inferInsert;
type FieldKey =
  | "name"
  | "firstName"
  | "lastName"
  | "email"
  | "company"
  | "role"
  | "location"
  | "linkedinUrl"
  | "phone";

const norm = (s: string) => s.trim().toLowerCase();

/** Resolve a column by exact header first, then by substring. -1 if absent. */
function colIndex(headers: string[], candidates: string[]): number {
  const exact = headers.findIndex((h) => candidates.includes(h));
  if (exact >= 0) return exact;
  return headers.findIndex((h) => candidates.some((c) => h.includes(c)));
}

/**
 * Model-reasoned column mapping. One cheap call reads the headers + a few sample
 * rows and maps arbitrary/messy CRM columns onto our schema — so cost is per FILE,
 * not per row. Falls back silently to heuristics when no LLM is configured.
 */
async function mapColumnsLLM(headers: string[], samples: string[][]): Promise<Partial<Record<FieldKey, number>>> {
  if (!headers.length || (!isConfigured("openrouter") && !isConfigured("llm"))) return {};
  const res = await extractJSON<Record<string, number | null>>({
    tier: "cheap",
    system: "You map arbitrary contact/CRM CSV columns onto a fixed schema. Return JSON only.",
    instruction:
      `Header columns (0-based index, name): ${JSON.stringify(headers.map((h, i) => [i, h]))}\n` +
      `Sample data rows: ${JSON.stringify(samples)}\n` +
      `Return JSON mapping each field to the best 0-based column index, or null if absent:\n` +
      `{"name":?,"firstName":?,"lastName":?,"email":?,"company":?,"role":?,"location":?,"linkedinUrl":?,"phone":?}\n` +
      `Pick the column whose values genuinely look like each field (emails contain @, LinkedIn URLs contain linkedin.com, etc.).`,
    fallback: {},
  });
  const out: Partial<Record<FieldKey, number>> = {};
  for (const [k, v] of Object.entries(res || {})) {
    if (typeof v === "number" && v >= 0 && v < headers.length) out[k as FieldKey] = v;
  }
  return out;
}

function guessRelationship(company: string, role: string): Rel {
  const s = `${company} ${role}`.toLowerCase();
  if (/capital|ventures?|partners|fund|equity|family office|investor|asset manage|wealth/.test(s))
    return "investor";
  return "other";
}

/**
 * CSV import. Parses the file, lets the model map messy columns, dedupes against
 * the existing network, inserts fast, then kicks off background enrichment +
 * grading (LinkedIn match, categorization, milestones) rather than blocking.
 */
export async function importCsvAction(formData: FormData) {
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) redirect("/dashboard/contacts?error=nofile");

  const text = await file.text();
  const parsed = Papa.parse(text, { skipEmptyLines: "greedy" });
  const grid = (parsed.data as string[][]).filter(
    (r) => Array.isArray(r) && r.some((cell) => cell && cell.trim()),
  );

  const headerIdx = grid.findIndex((row) =>
    row.some((cell) => /first name|full name|^\s*name\s*$|e-?mail/i.test(cell || "")),
  );
  if (headerIdx === -1) redirect("/dashboard/contacts?error=noheader");

  const headers = grid[headerIdx].map(norm);
  const body = grid.slice(headerIdx + 1);

  const mapped = await mapColumnsLLM(headers, body.slice(0, 3));

  const iFirst = mapped.firstName ?? colIndex(headers, ["first name", "given name"]);
  const iLast = mapped.lastName ?? colIndex(headers, ["last name", "family name", "surname"]);
  const iName =
    mapped.name ?? headers.findIndex((h) => h === "name" || h === "full name" || h === "display name");
  const iEmail = mapped.email ?? colIndex(headers, ["email address", "e-mail 1 - value", "email", "e-mail"]);
  const iCompany =
    mapped.company ?? colIndex(headers, ["company", "organization 1 - name", "organization", "employer"]);
  const iRole =
    mapped.role ?? colIndex(headers, ["position", "organization 1 - title", "title", "role", "job title"]);
  const iLoc = mapped.location ?? colIndex(headers, ["location", "address 1 - city", "city"]);
  const iUrl = mapped.linkedinUrl ?? colIndex(headers, ["url", "linkedin", "profile url"]);

  const at = (row: string[], i: number) => (i >= 0 && row[i] ? row[i].trim() : "");

  const user = await getPrimaryUser();
  if (!user) redirect("/dashboard/contacts?error=nouser");

  const existing = await db
    .select({ email: contacts.email, name: contacts.name })
    .from(contacts)
    .where(eq(contacts.userId, user.id));
  const existEmails = new Set(
    existing.map((e) => (e.email ? e.email.toLowerCase() : "")).filter(Boolean),
  );
  const existNames = new Set(existing.map((e) => norm(e.name)));

  const seen = new Set<string>();
  const toInsert: NewContact[] = [];

  for (const row of body) {
    const built =
      at(row, iName) || [at(row, iFirst), at(row, iLast)].filter(Boolean).join(" ").trim();
    const email = at(row, iEmail).toLowerCase();
    if (!built && !email) continue;

    const name = built || email;
    const key = email || norm(name);
    if (seen.has(key)) continue;
    seen.add(key);
    if (email && existEmails.has(email)) continue;
    if (!email && existNames.has(norm(name))) continue;

    const company = at(row, iCompany);
    const role = at(row, iRole);
    toInsert.push({
      userId: user.id,
      name,
      email: email || null,
      company: company || null,
      role: role || null,
      location: at(row, iLoc) || null,
      linkedinUrl: at(row, iUrl) || null,
      relationship: guessRelationship(company, role),
    });
  }

  for (let i = 0; i < toInsert.length; i += 500) {
    await db.insert(contacts).values(toInsert.slice(i, i + 500));
  }
  if (toInsert.length) await enqueue("enrichment");

  redirect(`/dashboard/contacts?imported=${toInsert.length}`);
}

/** Add a single contact by hand. */
export async function addContactAction(formData: FormData) {
  const g = (k: string) => {
    const v = formData.get(k);
    return v ? String(v).trim() : "";
  };
  const name = g("name");
  if (!name) redirect("/dashboard/contacts?error=noname");

  const user = await getPrimaryUser();
  if (!user) redirect("/dashboard/contacts?error=nouser");

  await db.insert(contacts).values({
    userId: user.id,
    name,
    email: g("email").toLowerCase() || null,
    company: g("company") || null,
    role: g("role") || null,
    location: g("location") || null,
    relationship: (g("relationship") || "other") as Rel,
  });
  await runOnce("recompute");
  redirect("/dashboard/contacts?added=1");
}
