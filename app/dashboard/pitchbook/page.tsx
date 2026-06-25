import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { pitchbookFirms } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { clearPitchbookAction } from "./actions";
import { PitchbookImport } from "./PitchbookImport";
import { PitchbookTable, type PBFacet } from "./PitchbookTable";

export const dynamic = "force-dynamic";

async function getFirms() {
  const u = await getPrimaryUser();
  if (!u) return [];
  try {
    return await db
      .select()
      .from(pitchbookFirms)
      .where(eq(pitchbookFirms.userId, u.id))
      .orderBy(sql`lower(${pitchbookFirms.name})`)
      .limit(5000);
  } catch {
    return [];
  }
}

export default async function PitchbookPage({
  searchParams,
}: {
  searchParams: Promise<{ imported?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const firms = await getFirms();
  const fieldsList = firms.map((f) => (f.normalizedFields ?? {}) as Record<string, string>);

  const distinctSingle = (key: string, cap = 100): string[] => {
    const m = new Map<string, number>();
    for (const nf of fieldsList) {
      const v = (nf[key] || "").trim();
      if (v) m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap).map((e) => e[0]).sort();
  };
  const distinctMulti = (key: string, cap = 100): string[] => {
    const m = new Map<string, number>();
    for (const nf of fieldsList) {
      for (const part of (nf[key] || "").split(/[,;]\s*/)) {
        const v = part.trim();
        if (v) m.set(v, (m.get(v) || 0) + 1);
      }
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap).map((e) => e[0]).sort();
  };

  const facets: PBFacet[] = [
    { key: "Firm Type", label: "Firm Type", values: distinctSingle("Firm Type") },
    { key: "Preferred Industry", label: "Industry", values: distinctMulti("Preferred Industry"), multi: true },
    { key: "Preferred Verticals", label: "Vertical", values: distinctMulti("Preferred Verticals"), multi: true },
    { key: "Preferred Geography", label: "Geography", values: distinctMulti("Preferred Geography"), multi: true },
    { key: "Last Investment Type", label: "Last Inv. Type", values: distinctSingle("Last Investment Type") },
  ].filter((f) => f.values.length);

  const rows = firms.map((f) => ({
    id: f.id,
    name: f.name,
    fields: (f.normalizedFields ?? {}) as Record<string, string>,
  }));

  const banner =
    sp.error != null
      ? `Import failed: ${sp.error === "nofile" ? "no file selected." : sp.error === "noheader" ? "couldn't read a header row." : sp.error}`
      : sp.imported != null
        ? `Imported ${sp.imported} firm${sp.imported === "1" ? "" : "s"}. Matching to your contacts in the background.`
        : null;

  return (
    <div className="mx-auto max-w-[1400px]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight">PitchBook</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Reference firm data used to enrich your rolodex. These are <strong>not</strong> contacts — they never
            mix with your network, and only fill in firm intel where a contact&apos;s firm matches.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {firms.length > 0 && (
            <form action={clearPitchbookAction}>
              <button className="rounded-lg border border-hairline px-3 py-2 text-sm text-muted hover:bg-black/[0.03]">
                Clear all
              </button>
            </form>
          )}
          <PitchbookImport />
        </div>
      </div>

      {banner && (
        <div
          className={`mt-4 rounded-lg px-4 py-2.5 text-sm ${sp.error ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}
        >
          {banner}
        </div>
      )}

      <p className="mt-4 text-sm text-muted">{firms.length} firms</p>

      {firms.length === 0 ? (
        <p className="mt-8 text-sm text-muted">
          No PitchBook data yet. Import a firms/investors export (.xlsx or .csv) to start enriching your contacts.
        </p>
      ) : (
        <div className="mt-4">
          <PitchbookTable rows={rows} facets={facets} />
        </div>
      )}
    </div>
  );
}
