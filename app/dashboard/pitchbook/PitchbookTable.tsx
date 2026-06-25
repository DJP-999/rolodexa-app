"use client";

import { useMemo, useState } from "react";

export type PBRow = { id: string; name: string; fields: Record<string, string> };
export type PBFacet = { key: string; label: string; values: string[]; multi?: boolean };

// Column key -> header label, in display order (Firm name is rendered separately, first).
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

export function PitchbookTable({ rows, facets }: { rows: PBRow[]; facets: PBFacet[] }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = rows.filter((r) => {
      if (needle) {
        const hay = `${r.name} ${Object.values(r.fields).join(" ")}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return facets.every((f) => {
        const s = sel[f.key];
        if (!s) return true;
        const v = r.fields[f.key] ?? "";
        return f.multi ? v.split(/[,;]\s*/).map((x) => x.trim()).includes(s) : v === s;
      });
    });
    if (sort) {
      const { key, dir } = sort;
      out = [...out].sort((a, b) => {
        const av = key === "name" ? a.name : a.fields[key] ?? "";
        const bv = key === "name" ? b.name : b.fields[key] ?? "";
        const num = parseFloat(av.replace(/[^0-9.]/g, "")) - parseFloat(bv.replace(/[^0-9.]/g, ""));
        const c = !isNaN(num) && av && bv && /[0-9]/.test(av) && /[0-9]/.test(bv) ? num : av.localeCompare(bv);
        return dir === "asc" ? c : -c;
      });
    }
    return out;
  }, [rows, facets, q, sel, sort]);

  const toggleSort = (key: string) =>
    setSort((s) => (!s || s.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : null));

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
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search firms, locations, industries, contacts…"
          className="w-72 rounded-lg border border-hairline bg-white px-3 py-1.5 text-sm"
        />
        {facets.map((f) => (
          <select
            key={f.key}
            value={sel[f.key] ?? ""}
            onChange={(e) => setSel((s) => ({ ...s, [f.key]: e.target.value }))}
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
        <span className="text-xs text-muted">{filtered.length} shown</span>
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
            {filtered.slice(0, 600).map((r) => (
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
    </div>
  );
}
