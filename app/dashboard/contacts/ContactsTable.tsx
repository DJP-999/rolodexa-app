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
  professionalFit: number | null;
  status: string | null;
  highValue: boolean | null;
  lastDays: string;
  lastContactedAt: string | null;
  customFields: Record<string, string>;
  normalizedFields: Record<string, string>;
  pitchbookData: Record<string, string> | null;
};
export type Facet = { key: string; label: string; categories: string[]; multi?: boolean };
type ColDef = { key: string; label: string; custom?: boolean };

// "lastInteraction" is pinned + always shown (see shownCols) — a relationship CRM must
// always answer "when did I last talk to them", regardless of imported columns.
const PINNED = "lastInteraction";
const CORE: { key: string; label: string }[] = [
  { key: "lastInteraction", label: "Last interaction" },
  { key: "company", label: "Company" },
  { key: "industry", label: "Industry" },
  { key: "location", label: "Location" },
  { key: "relationship", label: "Relationship" },
  { key: "fit", label: "Fit" },
  { key: "relevance", label: "Relevance" },
  { key: "days", label: "Days" },
];
const DEFAULT_VISIBLE = ["company", "industry", "relationship", "fit", "relevance"];
const STORAGE_KEY = "rolodexa.contactCols";
const ORDER_KEY = "rolodexa.contactOrder";
const SORT_KEY = "rolodexa.contactSort";

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
      {d.fit != null && (
        <div className="rounded-xl border border-hairline bg-black/[0.02] p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
            Why this rank · {Math.round(d.fit * 100)}% fit
          </div>
          {d.rationale && <p className="mt-1 text-ink/80">{d.rationale}</p>}
        </div>
      )}
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
  const [order, setOrder] = useState<string[]>([]);
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [facetSel, setFacetSel] = useState<Record<string, string>>({});
  const [picker, setPicker] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [data, setData] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState<string | null>(null);

  useEffect(() => {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v) {
        let vis: string[] = JSON.parse(v);
        // One-time migration: surface the new Fit column for users whose saved layout
        // predates it (without re-adding it if they later choose to hide it).
        if (Array.isArray(vis) && !vis.includes("fit") && !localStorage.getItem("rolodexa.contactCols.fitMig")) {
          const i = vis.indexOf("relevance");
          vis = i >= 0 ? [...vis.slice(0, i), "fit", ...vis.slice(i)] : [...vis, "fit"];
          localStorage.setItem(STORAGE_KEY, JSON.stringify(vis));
          localStorage.setItem("rolodexa.contactCols.fitMig", "1");
        }
        setVisible(vis);
      }
      const o = localStorage.getItem(ORDER_KEY);
      if (o) setOrder(JSON.parse(o));
      const s = localStorage.getItem(SORT_KEY);
      if (s) setSort(JSON.parse(s));
    } catch {
      /* ignore */
    }
  }, []);

  const persistOrder = (next: string[]) => {
    setOrder(next);
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const toggleSort = (key: string) =>
    setSort((s) => {
      const next =
        !s || s.key !== key
          ? { key, dir: "asc" as const }
          : s.dir === "asc"
            ? { key, dir: "desc" as const }
            : null;
      try {
        localStorage.setItem(SORT_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });

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

  // Columns in the user's saved order; unknown/new columns fall to the end.
  const orderedKeys = [
    ...order.filter((k) => allCols.some((c) => c.key === k)),
    ...allCols.map((c) => c.key).filter((k) => !order.includes(k)),
  ];
  const configurable = orderedKeys
    .map((k) => allCols.find((c) => c.key === k))
    .filter((c): c is ColDef => !!c && c.key !== PINNED && visible.includes(c.key));
  // Last interaction is always present, pinned right after Name — never hidden or reordered out.
  const pinned = allCols.find((c) => c.key === PINNED)!;
  const shownCols = [pinned, ...configurable];
  const colSpan = shownCols.length + 1; // + name column

  const onDropCol = (targetKey: string) => {
    if (!dragKey || dragKey === targetKey) return;
    const base = orderedKeys.slice();
    const from = base.indexOf(dragKey);
    if (from < 0) return;
    base.splice(from, 1);
    base.splice(base.indexOf(targetKey), 0, dragKey);
    persistOrder(base);
    setDragKey(null);
  };

  const sortVal = (r: Row, key: string): string | number => {
    switch (key) {
      case "name":
        return r.name.toLowerCase();
      case "company":
        return (r.company ?? "").toLowerCase();
      case "industry":
        return (r.industry ?? "").toLowerCase();
      case "location":
        return (r.location ?? "").toLowerCase();
      case "relationship":
        return (r.relationship ?? "").toLowerCase();
      case "relevance":
        return r.relevance ?? -1;
      case "fit":
        return r.professionalFit ?? -1;
      case "lastInteraction":
        return r.lastContactedAt ? new Date(r.lastContactedAt).getTime() : -1;
      case "days": {
        const n = parseInt(r.lastDays, 10);
        return isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
      }
      default:
        return (r.normalizedFields?.[key] ?? r.customFields?.[key] ?? "").toLowerCase();
    }
  };

  const filtered = rows.filter((r) =>
    facets.every((f) => {
      const sel = facetSel[f.key];
      if (!sel) return true;
      const val = r.normalizedFields?.[f.key] ?? r.customFields?.[f.key] ?? "";
      return f.multi ? val.split(" | ").includes(sel) : val === sel;
    }),
  );
  const sorted = sort
    ? [...filtered].sort((a, b) => {
        const av = sortVal(a, sort.key);
        const bv = sortVal(b, sort.key);
        const c =
          typeof av === "number" && typeof bv === "number"
            ? av - bv
            : String(av).localeCompare(String(bv));
        return sort.dir === "asc" ? c : -c;
      })
    : filtered;

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
    if (col.custom) {
      const own = r.normalizedFields?.[col.key] || r.customFields?.[col.key];
      if (own) return own;
      // Fall back to PitchBook firm intel (clearly tagged; never your own data).
      const pb = r.pitchbookData?.[col.key];
      if (pb)
        return (
          <span className="inline-flex items-center gap-1">
            <span className="text-ink/70">{pb}</span>
            <span
              className="rounded bg-indigo-50 px-1 text-[9px] font-semibold uppercase tracking-wide text-indigo-500"
              title="From your PitchBook reference data, not your own"
            >
              PB
            </span>
          </span>
        );
      return "—";
    }
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
      case "fit": {
        if (r.professionalFit == null) return <span className="text-muted">—</span>;
        const pct = Math.round(r.professionalFit * 100);
        const color = pct >= 85 ? "#16a34a" : pct >= 70 ? "#22c55e" : pct >= 55 ? "#f59e0b" : "#9ca3af";
        return (
          <span
            className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold"
            style={{ backgroundColor: `${color}1a`, color }}
            title="LLM domain/thesis fit to your focus"
          >
            {pct}
          </span>
        );
      }
      case "lastInteraction": {
        if (!r.lastContactedAt) return <span className="text-muted">No record yet</span>;
        const dt = new Date(r.lastContactedAt);
        const days = Math.floor((Date.now() - dt.getTime()) / 86_400_000);
        const date = dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        const ago = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`;
        return (
          <span className="whitespace-nowrap text-[13px] text-ink">
            {date} <span className="text-muted">· {ago}</span>
          </span>
        );
      }
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
                {allCols
                  .filter((c) => c.key !== PINNED)
                  .map((c) => (
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
              <th
                onClick={() => toggleSort("name")}
                className="cursor-pointer select-none px-3 py-3 font-normal hover:text-ink"
              >
                Name{sort?.key === "name" ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
              </th>
              {shownCols.map((c) => (
                <th
                  key={c.key}
                  draggable
                  onDragStart={() => setDragKey(c.key)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDropCol(c.key)}
                  onClick={() => toggleSort(c.key)}
                  title="Click to sort · drag to reorder"
                  className="cursor-pointer select-none whitespace-nowrap px-3 py-3 font-normal hover:text-ink"
                >
                  {c.label}
                  {sort?.key === c.key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
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
