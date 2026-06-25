"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import Papa from "papaparse";
import { db } from "@/db";
import { pitchbookFirms, contacts } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { firmPhrase } from "@/lib/match/entity";
import { enqueue } from "@/worker/scheduler";

const norm = (s: string) => s.trim().toLowerCase();

/** Find the firm/investor name column. */
function firmCol(headers: string[]): number {
  const pref = [
    "investor name",
    "company name",
    "firm name",
    "fund name",
    "organization name",
    "investor",
    "company",
    "firm",
    "organization",
    "name",
  ];
  for (const p of pref) {
    const exact = headers.findIndex((h) => h === p);
    if (exact >= 0) return exact;
  }
  for (const p of pref) {
    const sub = headers.findIndex((h) => h.includes(p));
    if (sub >= 0) return sub;
  }
  return 0;
}

/**
 * Import a PitchBook firms/investors export into the SEPARATE pitchbook_firms table.
 * This never creates contacts — it's reference data used to enrich the real rolodex.
 * Additive + deduped by normalized firm name, so re-imports don't pile up duplicates.
 */
export async function importPitchbookAction(formData: FormData) {
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) redirect("/dashboard/pitchbook?error=nofile");

  const text = await file.text();
  const parsed = Papa.parse(text, { skipEmptyLines: "greedy" });
  const grid = (parsed.data as string[][]).filter(
    (r) => Array.isArray(r) && r.some((c) => c && c.trim()),
  );
  // Header = first row with multiple non-empty cells.
  const headerIdx = grid.findIndex((row) => row.filter((c) => c && c.trim()).length >= 2);
  if (headerIdx === -1) redirect("/dashboard/pitchbook?error=noheader");

  const rawHeaders = grid[headerIdx].map((h) => (h ?? "").trim());
  const headers = rawHeaders.map(norm);
  const body = grid.slice(headerIdx + 1);
  const nameCol = firmCol(headers);

  const user = await getPrimaryUser();
  if (!user) redirect("/dashboard/pitchbook?error=nouser");

  const existing = await db
    .select({ nameKey: pitchbookFirms.nameKey })
    .from(pitchbookFirms)
    .where(eq(pitchbookFirms.userId, user.id));
  const seen = new Set(existing.map((e) => e.nameKey));

  const rows: (typeof pitchbookFirms.$inferInsert)[] = [];
  for (const row of body) {
    const name = (row[nameCol] ?? "").trim();
    if (!name) continue;
    const key = firmPhrase(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const cf: Record<string, string> = {};
    let n = 0;
    for (let j = 0; j < row.length && n < 50; j++) {
      if (j === nameCol) continue;
      const k = (rawHeaders[j] || `Column ${j + 1}`).slice(0, 60);
      const v = (row[j] ?? "").trim().slice(0, 400);
      if (v) {
        cf[k] = v;
        n++;
      }
    }
    rows.push({ userId: user.id, name: name.slice(0, 200), nameKey: key, customFields: cf });
  }

  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(pitchbookFirms).values(rows.slice(i, i + 200));
  }

  // Normalize firm fields + match to contacts in the background.
  if (rows.length) await enqueue("pitchbook-sync");

  revalidatePath("/dashboard/pitchbook");
  redirect(`/dashboard/pitchbook?imported=${rows.length}`);
}

/** Clear all imported PitchBook firms for the user (does not touch contacts). */
export async function clearPitchbookAction() {
  const user = await getPrimaryUser();
  if (!user) return;
  const ids = (
    await db.select({ id: pitchbookFirms.id }).from(pitchbookFirms).where(eq(pitchbookFirms.userId, user.id))
  ).map((r) => r.id);
  for (let i = 0; i < ids.length; i += 200) {
    await db.delete(pitchbookFirms).where(inArray(pitchbookFirms.id, ids.slice(i, i + 200)));
  }
  // Drop the pitchbook enrichment we wrote onto contacts (leave the user's own fields intact).
  await db.update(contacts).set({ pitchbookData: null }).where(eq(contacts.userId, user.id));
  revalidatePath("/dashboard/pitchbook");
  revalidatePath("/dashboard/contacts");
}
