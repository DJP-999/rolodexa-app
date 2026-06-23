"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, ArrowRight, Loader2, SlidersHorizontal } from "lucide-react";

export type Row = {
  id: string;
  name: string;
  role: string | null;
  company: string | null;
  industry: string | null;
  location: string | null;
  relationship: string | null;
  relevance: number | null;
  status: string | null;
  highValue: boolean | null;
  lastDays: string;
  customFields: Record<string, string>;
  normalizedFields: Record<string, string>;
};
export type Facet = { key: string; label: string; categories: string[] };
type ColDef = { key: string; label: string; custom?: boolean };

const CORE: { key: string; label: string }[] = [
  { key: "company", label: "Company" },
  { key: "industry", label: "Industry" },
  { key: "location", label: "Location" },
  { key: "relationship", label: "Relationship" },
  { key: "relevance", label: "Relevance" },
  { key: "days", label: "Days" },
];
const DEFAULT_VISIBLE = ["company", "industry", "location", "relationship", "relevance", "days"];
const STORAGE_KEY = "rolodexa.contactCols";

const REL_BADGE: Record<string, string> = {
  investor: "bg-violet-100 text-violet-700",
  friend: "bg-rose-100 text-rose-700",
  coworker: "bg-sky-100 text-sky-700",
  vendor: "bg-amber-100 text-amber-700",
  family: "bg-emerald-100 text-emerald-700",
  other: "bg-black/[0.05] text-muted",
};
const DOT: Record<string, string> = {
  active: "bg-emerald-500",
  warming: "bg-emerald-500",
  going_cold: "bg-amber-400",
  dormant: "bg-gray-300",
};
function meterColor(r: number | null): string {
  return r == null ? "#d1d5db" : r >= 70 ? "#22c55e" : "#f59e0b";
}
function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function Summary({ d, id }: { d: any; id: string }) {
  const s = d.stats ?? {};
  const li = s.lastInteraction;
  return (
    <div className="space-y-3 text-sm">
      {d.bio && <p className="text-ink">{d.bio}</p>}
      <div className="grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2">
        <div>
          <span className="text-muted">Firm: </span>
          <span className="text-ink">{[d.company, d.industry].filter(Boolean).join(" · ") || "—"}</span>
        </div>
        <div>
          <span className="text-muted">Interactions: </span>
          <span className="text-ink">
            {s.total ?? 0} total · {(s.emailIn ?? 0) + (s.emailOut ?? 0)} email ·{" "}
            {(s.msgIn ?? 0) + (s.msgOut ?? 0)} LinkedIn
          </span>
        </div>
        <div>
          <span className="text-muted">Last interaction: </span>
          <span className="text-ink">
            {li ? `${fmt(li.when)}${li.about ? ` — ${li.about}` : ""}` : "none synced"}
          </span>
        </div>
        <div>
          <span className="text-muted">Last meeting: </span>
          <span className="text-ink">{s.lastMeeting ? fmt(s.lastMeeting) : "—"}</span>
        </div>
      </div>
      <Link
        href={`/dashboard/contacts/${id}`}
        className="inline-flex items-center gap-1 text-[#2d6cf6] hover:underline"
      >
        View full profile <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}

export function ContactsTable({
  rows,
  customColumns,
  facets,
}: {
  rows: Row[];
  customColumns: { key: string; label: string }[];
  facets: Facet[];
}) {
  const allCols: ColDef[] = [...CORE, ...customColumns.map((c) => ({ ...c, custom: true }))];

  const [visible, setVisible] = useState<string[]>(DEFAULT_VISIBLE);
  const [facetSel, setFacetSel] = useState<Record<string, string>>({});
  const [picker, setPicker] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [data, setData] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setVisible(JSON.parse(saved));
    } catch {
      /* ignore */
    }
  }, []);

  const persist = (next: string[]) => {
    setVisible(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const toggleCol = (key: string) =>
    persist(visible.includes(key) ? visible.filter((k) => k !== key) : [...visible, key]);

  const shownCols = allCols.filter((c) => visible.includes(c.key));
  const colSpan = shownCols.length + 1; // + name column

  const filtered = rows.filter((r) =>
    facets.every((f) => {
      const sel = facetSel[f.key];
      if (!sel) return true;
      return (r.normalizedFields?.[f.key] ?? r.customFields?.[f.key] ?? "") === sel;
    }),
  );

  const toggleRow = async (id: string) => {
    if (open === id) return setOpen(null);
    setOpen(id);
    if (!data[id]) {
      setLoading(id);
      try {
        const r = await fetch(`/api/contacts/${id}`, { cache: "no-store" });
        const j = await r.json();
        setData((d) => ({ ...d, [id]: j }));
      } catch {
        /* ignore */
      } finally {
        setLoading(null);
      }
    }
  };

  const cellValue = (r: Row, col: ColDef): ReactNode => {
    if (col.custom) return r.normalizedFields?.[col.key] || r.customFields?.[col.key] || "—";
    switch (col.key) {
      case "company":
        return r.company ?? "—";
      case "industry":
        return r.industry ?? "—";
      case "location":
        return r.location ?? "—";
      case "relationship":
        return (
          <span
            className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium capitalize ${REL_BADGE[r.relationship ?? "other"]}`}
          >
            {r.relationship ?? "other"}
          </span>
        );
      case "relevance":
        return (
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-14 overflow-hidden rounded-full bg-hairline">
              <div
                className="h-full rounded-full"
                style={{ width: `${r.relevance ?? 0}%`, backgroundColor: meterColor(r.relevance) }}
              />
            </div>
            <span className="text-[13px] font-medium text-ink">{r.relevance ?? "—"}</span>
          </div>
        );
      case "days":
        return <span className="text-[13px] font-medium text-emerald-600">{r.lastDays}</span>;
      default:
        return "—";
    }
  };

  return (
    <div className="mt-4">
      {/* Toolbar: facets + column picker */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {facets.map((f) => (
          <select
            key={f.key}
            value={facetSel[f.key] ?? ""}
            onChange={(e) => setFacetSel((s) => ({ ...s, [f.key]: e.target.value }))}
            className="rounded-lg border border-hairline bg-white px-2.5 py-1.5 text-xs text-ink"
          >
            <option value="">{f.label}: All</option>
            {f.categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ))}
        <div className="relative ml-auto">
          <button
            type="button"
            onClick={() => setPicker((p) => !p)}
            className="flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-muted hover:bg-black/[0.03]"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" /> Columns
          </button>
          {picker && (
            <div className="absolute right-0 z-10 mt-1 w-56 rounded-xl border border-hairline bg-white p-2 shadow-lg">
              <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted">
                Show columns
              </div>
              <div className="max-h-72 overflow-y-auto">
                {allCols.map((c) => (
                  <label
                    key={c.key}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-black/[0.03]"
                  >
                    <input
                      type="checkbox"
                      checked={visible.includes(c.key)}
                      onChange={() => toggleCol(c.key)}
                    />
                    <span className="text-ink">{c.label}</span>
                    {c.custom && <span className="text-[10px] text-muted">CSV</span>}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-hairline bg-white">
        <table className="w-full">
          <thead>
            <tr className="border-b border-hairline text-left text-xs text-muted">
              <th className="px-3 py-3 font-normal">Name</th>
              {shownCols.map((c) => (
                <th key={c.key} className="px-3 py-3 font-normal whitespace-nowrap">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const expanded = open === r.id;
              const d = data[r.id];
              return (
                <Fragment key={r.id}>
                  <tr className="border-b border-hairline/70 hover:bg-black/[0.015]">
                    <td className="px-3 py-3.5">
                      <button onClick={() => toggleRow(r.id)} className="flex items-center gap-3 text-left">
                        <div className="relative">
                          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-black/[0.05] text-xs font-medium text-muted">
                            {r.name.charAt(0).toUpperCase()}
                          </div>
                          <span
                            className={`absolute -bottom-0.5 left-0 h-2.5 w-2.5 rounded-full border-2 border-white ${DOT[r.status ?? "active"]}`}
                          />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 text-sm font-medium text-ink">
                            {r.name} {r.highValue ? "🔥" : ""}
                            <ChevronDown
                              className={`h-3.5 w-3.5 text-muted transition-transform ${expanded ? "rotate-180" : ""}`}
                            />
                          </div>
                          <div className="text-xs text-muted">{r.role ?? "—"}</div>
                        </div>
                      </button>
                    </td>
                    {shownCols.map((c) => (
                      <td key={c.key} className="px-3 py-3.5 align-top text-[13px] text-muted">
                        {cellValue(r, c)}
                      </td>
                    ))}
                  </tr>
                  {expanded && (
                    <tr className="border-b border-hairline/70 bg-black/[0.015]">
                      <td colSpan={colSpan} className="px-5 py-4">
                        {loading === r.id && !d ? (
                          <span className="flex items-center gap-2 text-sm text-muted">
                            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                          </span>
                        ) : d?.ok ? (
                          <Summary d={d} id={r.id} />
                        ) : (
                          <span className="text-sm text-muted">No details available.</span>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
