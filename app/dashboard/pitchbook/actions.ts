"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq, inArray } from "drizzle-orm";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { db } from "@/db";
import { pitchbookFirms, contacts } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { firmPhrase } from "@/lib/match/entity";
import { enqueue } from "@/worker/scheduler";

const norm = (s: string) => s.trim().toLowerCase();

/** Find the firm/investor NAME column (PitchBook calls it "Investors"; avoid "Investor ID"). */
function firmCol(headers: string[]): number {
  const exact = [
    "investors",
    "investor name",
    "investor legal name",
    "company name",
    "firm name",
    "fund name",
    "organization name",
    "name",
    "investor",
    "company",
    "firm",
  ];
  for (const p of exact) {
    const i = headers.findIndex((h) => h === p);
    if (i >= 0) return i;
  }
  for (const p of ["investor name", "company name", "firm name", "investors", "company", "firm"]) {
    const i = headers.findIndex(
      (h) => h.includes(p) && !/\bid\b|address|contact|email|phone|website/.test(h),
    );
    if (i >= 0) return i;
  }
  return 0;
}

/** Read a CSV or XLSX upload into a raw grid (array of rows). */
async function toGrid(file: File): Promise<string[][]> {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const buf = Buffer.from(await file.arrayBuffer());
    const wb = XLSX.read(buf, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }) as unknown[][];
    return rows.map((r) => (Array.isArray(r) ? r.map((c) => (c == null ? "" : String(c))) : []));
  }
  const text = await file.text();
  return Papa.parse(text, { skipEmptyLines: "greedy" }).data as string[][];
}

/**
 * Import a PitchBook firms/investors export into the SEPARATE pitchbook_firms table.
 * This never creates contacts — it's reference data used to enrich the real rolodex.
 * Additive + deduped by normalized firm name, so re-imports don't pile up duplicates.
 */
export async function importPitchbookAction(formData: FormData) {
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) redirect("/dashboard/pitchbook?error=nofile");

  const grid = await toGrid(file);
  // PitchBook exports have a few preamble rows ("Downloaded on…", "All Columns") before
  // the real header — so the header is the first row with MANY non-empty cells.
  const headerIdx = grid.findIndex((row) => row.filter((c) => c && c.trim()).length >= 8);
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
    // PitchBook exports are wide (160+ cols); capture broadly so the key intel columns
    // (Preferred Industry/Deal Size, AUM, etc.) aren't cut off.
    for (let j = 0; j < row.length && n < 180; j++) {
      if (j === nameCol) continue;
      const k = (rawHeaders[j] || `Column ${j + 1}`).slice(0, 80);
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
