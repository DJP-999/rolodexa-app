import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { pitchbookFirms } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { clearPitchbookAction } from "./actions";
import { PitchbookImport } from "./PitchbookImport";
import { PitchbookTable, type PBFacet } from "./PitchbookTable";

export const dynamic = "force-dynamic";

type Filters = { q: string; ft: string; ind: string; vert: string; geo: string; lit: string };

function rowsOf(res: unknown): { v: string }[] {
  const r = res as { rows?: unknown[] } | unknown[];
  return (Array.isArray(r) ? r : (r?.rows ?? [])) as { v: string }[];
}

/** Server-side filtered firms (search across name/all columns + facet filters), capped. */
async function getFirms(userId: string, f: Filters) {
  const conds = [eq(pitchbookFirms.userId, userId)];
  if (f.q) {
    const like = `%${f.q.toLowerCase()}%`;
    conds.push(
      sql`(lower(${pitchbookFirms.name}) like ${like} or lower(${pitchbookFirms.customFields}::text) like ${like})`,
    );
  }
  if (f.ft) conds.push(sql`${pitchbookFirms.normalizedFields}->>'Firm Type' = ${f.ft}`);
  if (f.ind) conds.push(sql`${pitchbookFirms.normalizedFields}->>'Preferred Industry' ilike ${`%${f.ind}%`}`);
  if (f.vert) conds.push(sql`${pitchbookFirms.normalizedFields}->>'Preferred Verticals' ilike ${`%${f.vert}%`}`);
  if (f.geo) conds.push(sql`${pitchbookFirms.normalizedFields}->>'Preferred Geography' ilike ${`%${f.geo}%`}`);
  if (f.lit) conds.push(sql`${pitchbookFirms.normalizedFields}->>'Last Investment Type' = ${f.lit}`);
  try {
    return await db
      .select()
      .from(pitchbookFirms)
      .where(and(...conds))
      .orderBy(sql`lower(${pitchbookFirms.name})`)
      .limit(300);
  } catch {
    return [];
  }
}

async function totalCount(userId: string): Promise<number> {
  try {
    const r = await db.execute(
      sql`SELECT count(*)::int AS v FROM pitchbook_firms WHERE user_id = ${userId}`,
    );
    return Number(rowsOf(r)[0]?.v ?? 0);
  } catch {
    return 0;
  }
}

/** Distinct values of a single normalized field across ALL firms (for a facet dropdown). */
async function singleFacet(userId: string, key: string): Promise<string[]> {
  try {
    const r = await db.execute(sql`
      SELECT normalized_fields->>${key} AS v, count(*)::int AS c
      FROM pitchbook_firms
      WHERE user_id = ${userId} AND coalesce(normalized_fields->>${key}, '') <> ''
      GROUP BY 1 ORDER BY c DESC LIMIT 100
    `);
    return rowsOf(r).map((x) => x.v).sort();
  } catch {
    return [];
  }
}

/** Distinct comma-split tokens of a multi-value normalized field across ALL firms. */
async function multiFacet(userId: string, key: string): Promise<string[]> {
  try {
    const r = await db.execute(sql`
      SELECT btrim(x) AS v, count(*)::int AS c
      FROM pitchbook_firms, unnest(string_to_array(coalesce(normalized_fields->>${key}, ''), ',')) AS x
      WHERE user_id = ${userId} AND btrim(x) <> ''
      GROUP BY 1 ORDER BY c DESC LIMIT 100
    `);
    return rowsOf(r).map((x) => x.v).sort();
  } catch {
    return [];
  }
}

export default async function PitchbookPage({
  searchParams,
}: {
  searchParams: Promise<{ imported?: string; error?: string; q?: string; ft?: string; ind?: string; vert?: string; geo?: string; lit?: string }>;
}) {
  const sp = await searchParams;
  const u = await getPrimaryUser();
  const f: Filters = {
    q: sp.q ?? "",
    ft: sp.ft ?? "",
    ind: sp.ind ?? "",
    vert: sp.vert ?? "",
    geo: sp.geo ?? "",
    lit: sp.lit ?? "",
  };

  const [firms, total, ftVals, indVals, vertVals, geoVals, litVals] = u
    ? await Promise.all([
        getFirms(u.id, f),
        totalCount(u.id),
        singleFacet(u.id, "Firm Type"),
        multiFacet(u.id, "Preferred Industry"),
        multiFacet(u.id, "Preferred Verticals"),
        multiFacet(u.id, "Preferred Geography"),
        singleFacet(u.id, "Last Investment Type"),
      ])
    : [[], 0, [], [], [], [], []];

  const facets: PBFacet[] = [
    { param: "ft", label: "Firm Type", values: ftVals as string[], selected: f.ft },
    { param: "ind", label: "Industry", values: indVals as string[], selected: f.ind },
    { param: "vert", label: "Vertical", values: vertVals as string[], selected: f.vert },
    { param: "geo", label: "Geography", values: geoVals as string[], selected: f.geo },
    { param: "lit", label: "Last Inv. Type", values: litVals as string[], selected: f.lit },
  ].filter((x) => x.values.length || x.selected);

  const rows = (firms as typeof firms).map((fm) => ({
    id: fm.id,
    name: fm.name,
    fields: (fm.normalizedFields ?? {}) as Record<string, string>,
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
          <h1 className="text-[28px] font-bold tracking-tight">Database</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Reference firm data used to enrich your rolodex. These are <strong>not</strong> contacts — they never
            mix with your network, and only fill in firm intel where a contact&apos;s firm matches.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {total > 0 && (
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

      <p className="mt-4 text-sm text-muted">{total.toLocaleString()} firms</p>

      {total === 0 ? (
        <p className="mt-8 text-sm text-muted">
          No reference data yet. Import a firms/investors export (.xlsx or .csv) to start enriching your contacts.
        </p>
      ) : (
        <div className="mt-4">
          <PitchbookTable rows={rows} facets={facets} q={f.q} total={total} />
        </div>
      )}
    </div>
  );
}
