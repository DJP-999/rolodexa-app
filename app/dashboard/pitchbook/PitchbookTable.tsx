"use client";

import { useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type PBRow = { id: string; name: string; fields: Record<string, string> };
export type PBFacet = { param: string; label: string; values: string[]; selected: string };

const COLUMNS: [string, string][] = [
  ["Firm Type", "Firm Type"],
  ["HQ Location", "HQ Location"],
  ["Year Founded", "Founded"],
  ["Website", "Website"],
  ["Primary Contact", "Primary Contact"],
  ["Primary Contact Email", "Contact Email"],
  ["AUM", "AUM"],
  ["Check Size", "Check Size"],
  ["Fund Size", "Fund Size"],
  ["Preferred Industry", "Pref. Industry"],
  ["Preferred Verticals", "Pref. Verticals"],
  ["Preferred Geography", "Pref. Geography"],
  ["Preferred Investment Types", "Pref. Inv. Types"],
  ["Last Investment", "Last Investment"],
  ["Last Investment Date", "Last Inv. Date"],
  ["Last Investment Type", "Last Inv. Type"],
  ["Last Investment Type 2", "Last Inv. Type 2"],
  ["Last Investment Class", "Last Inv. Class"],
  ["Description", "Description"],
];
const WIDE = new Set(["Preferred Industry", "Preferred Verticals", "Preferred Investment Types", "Description"]);
const CAP = 300;

export function PitchbookTable({ rows, facets, q, total }: { rows: PBRow[]; facets: PBFacet[]; q: string; total: number }) {
  const router = useRouter();
  const params = useSearchParams();
  const pathname = usePathname();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const [pending, setPending] = useState(false);

  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params.toString());
    if (v) p.set(k, v);
    else p.delete(k);
    setPending(true);
    router.push(p.toString() ? `${pathname}?${p}` : pathname);
  };
  const onSearch = (v: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setParam("q", v.trim()), 350);
  };

  const toggleSort = (key: string) =>
    setSort((s) => (!s || s.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : null));

  const sorted = sort
    ? [...rows].sort((a, b) => {
        const av = sort.key === "name" ? a.name : a.fields[sort.key] ?? "";
        const bv = sort.key === "name" ? b.name : b.fields[sort.key] ?? "";
        const num = parseFloat(av.replace(/[^0-9.]/g, "")) - parseFloat(bv.replace(/[^0-9.]/g, ""));
        const c = !isNaN(num) && /[0-9]/.test(av) && /[0-9]/.test(bv) ? num : av.localeCompare(bv);
        return sort.dir === "asc" ? c : -c;
      })
    : rows;

  const cell = (r: PBRow, key: string) => {
    const v = r.fields[key];
    if (!v) return <span className="text-muted">—</span>;
    if (key === "Website")
      return (
        <a href={v.startsWith("http") ? v : `https://${v}`} target="_blank" rel="noopener noreferrer" className="text-[#2d6cf6] hover:underline">
          {v}
        </a>
      );
    if (key === "Primary Contact Email")
      return <a href={`mailto:${v}`} className="text-[#2d6cf6] hover:underline">{v}</a>;
    return <span title={v}>{v}</span>;
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          defaultValue={q}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search all firms — name, location, industry, contact…"
          className="w-80 rounded-lg border border-hairline bg-white px-3 py-1.5 text-sm"
        />
        {facets.map((f) => (
          <select
            key={f.param}
            value={f.selected}
            onChange={(e) => setParam(f.param, e.target.value)}
            className="rounded-lg border border-hairline bg-white px-2.5 py-1.5 text-xs text-ink"
          >
            <option value="">{f.label}: All</option>
            {f.values.map((v) => (
              <option key={v} value={v}>
                {v.length > 40 ? v.slice(0, 40) + "…" : v}
              </option>
            ))}
          </select>
        ))}
        <span className="text-xs text-muted">
          {pending ? "searching…" : `${rows.length}${rows.length >= CAP ? "+" : ""} of ${total.toLocaleString()} match`}
        </span>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-hairline bg-white">
        <table className="w-full">
          <thead>
            <tr className="border-b border-hairline text-left text-xs text-muted">
              <th
                onClick={() => toggleSort("name")}
                className="sticky left-0 z-10 cursor-pointer select-none bg-white px-3 py-3 font-normal hover:text-ink"
              >
                Firm{sort?.key === "name" ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
              </th>
              {COLUMNS.map(([key, label]) => (
                <th
                  key={key}
                  onClick={() => toggleSort(key)}
                  className="cursor-pointer select-none whitespace-nowrap px-3 py-3 font-normal hover:text-ink"
                >
                  {label}
                  {sort?.key === key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} className="border-b border-hairline/70 align-top">
                <td className="sticky left-0 z-10 bg-white px-3 py-3 text-sm font-medium text-ink">{r.name}</td>
                {COLUMNS.map(([key]) => (
                  <td
                    key={key}
                    className={`px-3 py-3 text-[13px] text-ink/80 ${WIDE.has(key) ? "max-w-[260px] truncate" : "whitespace-nowrap"}`}
                  >
                    {cell(r, key)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length >= CAP && (
        <p className="mt-2 text-xs text-muted">
          Showing the first {CAP} matches — narrow with search or a filter to see more specific results.
        </p>
      )}
    </div>
  );
}
