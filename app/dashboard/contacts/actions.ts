"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
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
  if (
    /capital|ventures?|partners|fund|equity|family office|investor|asset|wealth|holdings?|investment|advis|secondar|hedge|private equity|growth/.test(
      s,
    )
  )
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
  const rawHeaders = grid[headerIdx].map((h) => (h ?? "").trim());
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
  const iPhone = mapped.phone ?? colIndex(headers, ["phone", "mobile", "cell"]);

  // Columns already mapped to core fields; everything else is kept as a custom field.
  const usedIdx = new Set([iName, iFirst, iLast, iEmail, iCompany, iRole, iLoc, iUrl, iPhone].filter((i) => i >= 0));

  const at = (row: string[], i: number) => (i >= 0 && row[i] ? row[i].trim() : "");
  const capturesCustom = (row: string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    let n = 0;
    for (let j = 0; j < row.length && n < 40; j++) {
      if (usedIdx.has(j)) continue;
      const key = (rawHeaders[j] || `Column ${j + 1}`).slice(0, 60);
      const val = (row[j] ?? "").trim().slice(0, 300);
      if (val) {
        out[key] = val;
        n++;
      }
    }
    return out;
  };

  const user = await getPrimaryUser();
  if (!user) redirect("/dashboard/contacts?error=nouser");

  const existing = await db
    .select({ id: contacts.id, email: contacts.email, name: contacts.name })
    .from(contacts)
    .where(eq(contacts.userId, user.id));
  const idByEmail = new Map<string, string>();
  const idByName = new Map<string, string>();
  for (const e of existing) {
    if (e.email) idByEmail.set(e.email.toLowerCase(), e.id);
    idByName.set(norm(e.name), e.id);
  }

  const seen = new Set<string>();
  const toInsert: NewContact[] = [];
  const toUpdate: { id: string; customFields: Record<string, string> }[] = [];

  for (const row of body) {
    const built =
      at(row, iName) || [at(row, iFirst), at(row, iLast)].filter(Boolean).join(" ").trim();
    const email = at(row, iEmail).toLowerCase();
    if (!built && !email) continue;

    const name = built || email;
    const key = email || norm(name);
    if (seen.has(key)) continue;
    seen.add(key);

    const custom = capturesCustom(row);
    // Match the contact we already have (email is the stronger key) and backfill, else insert.
    const existingId = email ? idByEmail.get(email) : idByName.get(norm(name));
    if (existingId) {
      if (Object.keys(custom).length) toUpdate.push({ id: existingId, customFields: custom });
      continue;
    }

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
      customFields: custom,
      source: "csv",
    });
  }

  for (let i = 0; i < toInsert.length; i += 500) {
    await db.insert(contacts).values(toInsert.slice(i, i + 500));
  }
  // Backfill the full CSV columns onto existing contacts, in parallel chunks.
  for (let i = 0; i < toUpdate.length; i += 50) {
    await Promise.all(
      toUpdate
        .slice(i, i + 50)
        .map((u) => db.update(contacts).set({ customFields: u.customFields }).where(eq(contacts.id, u.id))),
    );
  }

  if (toInsert.length || toUpdate.length) {
    await enqueue("split-contacts"); // break "two people in one cell" rows into distinct contacts first
    await enqueue("apify-enrich"); // full LinkedIn profiles on import (no rate limit) when APIFY_TOKEN is set
    await enqueue("enrichment");
    await enqueue("normalize"); // group messy custom-column values into clean categories
    await enqueue("pitchbook-sync"); // fill firm intel from any imported PitchBook reference data
  }

  redirect(`/dashboard/contacts?imported=${toInsert.length}&updated=${toUpdate.length}`);
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
    source: "manual",
  });
  await runOnce("recompute");
  redirect("/dashboard/contacts?added=1");
}

/** Flag/unflag a contact as a VIP (must-watch): always news-swept, floored relevance, clears the gate. */
export async function setHighValueAction(id: string, value: boolean) {
  if (!id) return;
  const user = await getPrimaryUser();
  if (!user) return;
  await db
    .update(contacts)
    .set({ highValue: value })
    .where(and(eq(contacts.id, id), eq(contacts.userId, user.id)));
  await runOnce("recompute"); // apply the VIP relevance floor immediately
  revalidatePath(`/dashboard/contacts/${id}`);
  revalidatePath("/dashboard/contacts");
}

/** Permanently delete a contact (and its cascading claims/suggestions). Scoped to the owner. */
/** Manually edit a contact's core fields. Empty strings clear a field (except name). */
export async function updateContactAction(
  id: string,
  v: {
    name?: string;
    email?: string;
    company?: string;
    role?: string;
    location?: string;
    industry?: string;
    linkedinUrl?: string;
    relationship?: string;
    summary?: string;
  },
): Promise<{ ok: boolean }> {
  const user = await getPrimaryUser();
  if (!user || !id) return { ok: false };
  const owned = (
    await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.userId, user.id)))
      .limit(1)
  )[0];
  if (!owned) return { ok: false };

  const upd: Partial<typeof contacts.$inferInsert> = {};
  const clean = (s?: string) => (s ?? "").trim();
  if (v.name !== undefined && clean(v.name)) upd.name = clean(v.name).slice(0, 200);
  if (v.email !== undefined) upd.email = clean(v.email).toLowerCase() || null;
  if (v.company !== undefined) upd.company = clean(v.company) || null;
  if (v.role !== undefined) upd.role = clean(v.role) || null;
  if (v.location !== undefined) upd.location = clean(v.location) || null;
  if (v.industry !== undefined) upd.industry = clean(v.industry) || null;
  if (v.linkedinUrl !== undefined) upd.linkedinUrl = clean(v.linkedinUrl) || null;
  if (v.summary !== undefined) upd.summary = clean(v.summary) || null;
  const REL = ["investor", "friend", "coworker", "vendor", "family", "other"];
  if (v.relationship && REL.includes(v.relationship))
    upd.relationship = v.relationship as typeof contacts.$inferInsert["relationship"];

  if (Object.keys(upd).length) await db.update(contacts).set(upd).where(eq(contacts.id, id));
  revalidatePath(`/dashboard/contacts/${id}`);
  revalidatePath("/dashboard/contacts");
  return { ok: true };
}

export async function deleteContactAction(id: string) {
  if (!id) return;
  const user = await getPrimaryUser();
  if (!user) return;
  await db.delete(contacts).where(and(eq(contacts.id, id), eq(contacts.userId, user.id)));
  revalidatePath("/dashboard/contacts");
  redirect("/dashboard/contacts");
}
