import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { pitchbookFirms } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { clearPitchbookAction } from "./actions";
import { PitchbookImport } from "./PitchbookImport";

export const dynamic = "force-dynamic";

const COLS = ["Firm Type", "Region", "Interests", "Check Size", "Fund Size", "AUM"];

async function getFirms() {
  const u = await getPrimaryUser();
  if (!u) return [];
  try {
    return await db
      .select()
      .from(pitchbookFirms)
      .where(eq(pitchbookFirms.userId, u.id))
      .orderBy(sql`lower(${pitchbookFirms.name})`)
      .limit(1000);
  } catch {
    return [];
  }
}

export default async function PitchbookPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; imported?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const firms = await getFirms();
  const q = (sp.q ?? "").toLowerCase();
  const rows = q
    ? firms.filter((f) => {
        const hay = `${f.name} ${Object.values((f.customFields ?? {}) as Record<string, string>).join(" ")}`.toLowerCase();
        return hay.includes(q);
      })
    : firms;

  const banner =
    sp.error != null
      ? `Import failed: ${sp.error === "nofile" ? "no file selected." : sp.error === "noheader" ? "couldn't read a header row." : sp.error}`
      : sp.imported != null
        ? `Imported ${sp.imported} firm${sp.imported === "1" ? "" : "s"}. Matching to your contacts in the background.`
        : null;

  return (
    <div className="mx-auto max-w-6xl">
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
          No PitchBook data yet. Import a firms/investors CSV export to start enriching your contacts.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-2xl border border-hairline bg-white">
          <table className="w-full">
            <thead>
              <tr className="border-b border-hairline text-left text-xs text-muted">
                <th className="px-3 py-3 font-normal">Firm</th>
                {COLS.map((c) => (
                  <th key={c} className="whitespace-nowrap px-3 py-3 font-normal">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 500).map((f) => {
                const nf = (f.normalizedFields ?? {}) as Record<string, string>;
                return (
                  <tr key={f.id} className="border-b border-hairline/70">
                    <td className="px-3 py-3 text-sm font-medium text-ink">{f.name}</td>
                    {COLS.map((c) => (
                      <td key={c} className="px-3 py-3 align-top text-[13px] text-muted">
                        {nf[c] || "—"}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
