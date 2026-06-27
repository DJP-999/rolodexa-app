"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, ArrowRight, Loader2, SlidersHorizontal, Pencil, Info } from "lucide-react";
import DeleteContactButton from "./DeleteContactButton";
import VipToggle from "./VipToggle";
import ReconnectButton from "./ReconnectButton";

export type Row = {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  linkedinUrl: string | null;
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
  { key: "email", label: "Email" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "industry", label: "Industry" },
  { key: "location", label: "Location" },
  { key: "relationship", label: "Relationship" },
  { key: "fit", label: "Fit" },
  { key: "relevance", label: "Relevance" },
  { key: "days", label: "Days" },
];
const DEFAULT_VISIBLE = ["company", "email", "linkedin", "industry", "relationship", "fit", "relevance"];

// Plain-English explanations shown on hover next to the column header.
const COLUMN_HELP: Record<string, string> = {
  fit: "How well this contact and their firm match YOUR deal focus — graded by AI from their LinkedIn profile, live web research on their current firm, and your own notes. It's about who they are, regardless of your history together.",
  relevance:
    "How much to prioritize this person right now. A weighted blend of Fit (the biggest factor), how recently you last connected, your relationship strength, and reply likelihood. This is what ranks your rolodex — and a high Fit floors Relevance high even with no past contact.",
};

/** A small "i" that reveals an explanation on hover. Stops clicks from triggering a column sort. */
function InfoTip({ text }: { text: string }) {
  return (
    <span className="group/info relative inline-flex align-middle" onClick={(e) => e.stopPropagation()}>
      <Info className="h-3 w-3 text-muted/70 hover:text-ink" />
      <span className="pointer-events-none absolute left-1/2 top-5 z-30 hidden w-64 -translate-x-1/2 whitespace-normal rounded-lg border border-hairline bg-white p-2.5 text-[11px] font-normal leading-snug text-ink shadow-lg group-hover/info:block">
        {text}
      </span>
    </span>
  );
}
const STORAGE_KEY = "rolodexa.contactCols";
const ORDER_KEY = "rolodexa.contactOrder";
const SORT_KEY = "rolodexa.contactSort";
const LABELS_KEY = "rolodexa.contactLabels";

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
/** Parse a date-like string (e.g. "6/16/2026", "2026-06-16") to a timestamp, else null. */
function parseMaybeDate(s: string): number | null {
  if (!s || !/\d{1,4}[/.\-]\d{1,2}([/.\-]\d{1,4})?/.test(s)) return null;
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

function Summary({ d, id, highValue }: { d: any; id: string; highValue: boolean }) {
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
      {d.pitchbook && Object.keys(d.pitchbook).length > 0 && <PitchbookProfile pb={d.pitchbook} />}
      <ReconnectButton id={id} name={d.name ?? "this contact"} />
      <div className="flex items-center justify-between gap-3 pt-1">
        <Link
          href={`/dashboard/contacts/${id}`}
          className="inline-flex items-center gap-1 text-[#2d6cf6] hover:underline"
        >
          View full profile <ArrowRight className="h-3.5 w-3.5" />
        </Link>
        <div className="flex items-center gap-2">
          <VipToggle id={id} initial={highValue} />
          <DeleteContactButton id={id} name={d.name ?? "this contact"} />
        </div>
      </div>
    </div>
  );
}

const PB_ORDER = [
  "Description",
  "Firm Type",
  "Year Founded",
  "HQ Location",
  "Website",
  "Primary Contact",
  "Primary Contact Email",
  "AUM",
  "Check Size",
  "Fund Size",
  "Preferred Industry",
  "Preferred Verticals",
  "Preferred Geography",
  "Preferred Investment Types",
  "Last Investment",
  "Last Investment Date",
  "Last Investment Type",
  "Last Investment Type 2",
  "Last Investment Class",
];

/** Firm intel pulled from the user's PitchBook reference data for this contact's firm. */
function PitchbookProfile({ pb }: { pb: Record<string, string> }) {
  const keys = PB_ORDER.filter((k) => pb[k]);
  return (
    <div className="rounded-xl border border-indigo-200/70 bg-indigo-50/40 p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-indigo-600">
        PitchBook firm intel
        <span className="rounded bg-indigo-100 px-1 text-[9px] font-semibold text-indigo-500">PB</span>
      </div>
      {pb["Description"] && <p className="mt-1.5 text-ink/80">{pb["Description"]}</p>}
      <div className="mt-2 grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
        {keys
          .filter((k) => k !== "Description")
          .map((k) => (
            <div key={k}>
              <span className="text-muted">{k}: </span>
              {/Email/.test(k) ? (
                <a href={`mailto:${pb[k]}`} className="text-[#2d6cf6] hover:underline">
                  {pb[k]}
                </a>
              ) : k === "Website" ? (
                <a
                  href={pb[k].startsWith("http") ? pb[k] : `https://${pb[k]}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#2d6cf6] hover:underline"
                >
                  {pb[k]}
                </a>
              ) : (
                <span className="text-ink">{pb[k]}</span>
              )}
            </div>
          ))}
      </div>
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
  const [labels, setLabels] = useState<Record<string, string>>({});
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
        // One-time migration: surface Email + LinkedIn columns (right after Company).
        if (Array.isArray(vis) && !localStorage.getItem("rolodexa.contactCols.contactColMig")) {
          const add = ["email", "linkedin"].filter((k) => !vis.includes(k));
          if (add.length) {
            const i = vis.indexOf("company");
            vis = i >= 0 ? [...vis.slice(0, i + 1), ...add, ...vis.slice(i + 1)] : [...add, ...vis];
            localStorage.setItem(STORAGE_KEY, JSON.stringify(vis));
          }
          localStorage.setItem("rolodexa.contactCols.contactColMig", "1");
        }
        setVisible(vis);
      }
      let ord = localStorage.getItem(ORDER_KEY);
      // One-time order patch: place Email + LinkedIn right after Company for users whose
      // saved order predates them (otherwise new columns append far right, off-screen).
      if (ord && !localStorage.getItem("rolodexa.contactColOrderMig")) {
        try {
          let o2: string[] = JSON.parse(ord);
          if (Array.isArray(o2) && o2.length) {
            o2 = o2.filter((k) => k !== "email" && k !== "linkedin");
            const i = o2.indexOf("company");
            const ins = ["email", "linkedin"];
            o2 = i >= 0 ? [...o2.slice(0, i + 1), ...ins, ...o2.slice(i + 1)] : [...ins, ...o2];
            ord = JSON.stringify(o2);
            localStorage.setItem(ORDER_KEY, ord);
          }
        } catch {
          /* ignore */
        }
        localStorage.setItem("rolodexa.contactColOrderMig", "1");
      }
      if (ord) setOrder(JSON.parse(ord));
      const s = localStorage.getItem(SORT_KEY);
      if (s) setSort(JSON.parse(s));
      const lb = localStorage.getItem(LABELS_KEY);
      if (lb) setLabels(JSON.parse(lb));
    } catch {
      /* ignore */
    }
  }, []);

  const labelOf = (c: { key: string; label: string }) => labels[c.key] ?? c.label;
  const renameCol = (key: string, current: string) => {
    const v = window.prompt("Rename column", current);
    if (v === null) return;
    const next = { ...labels };
    if (v.trim()) next[key] = v.trim();
    else delete next[key];
    setLabels(next);
    try {
      localStorage.setItem(LABELS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

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
      case "email":
        return (r.email ?? "").toLowerCase();
      case "linkedin":
        return (r.linkedinUrl ?? "").toLowerCase();
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
  // Default view CLUSTERS contacts by firm: a firm is ranked by its strongest member, and all
  // of its people sit together as a block (best-graded first within the firm). So colleagues at
  // the same firm — e.g. InGoodCompany's Tim Ringel / Gilles Bouillot / Julius Ewig — appear
  // adjacent, instead of scattered across the list by tiny per-person score differences.
  const firmKey = (r: Row) => (r.company ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const clusterByFirm = (list: Row[]): Row[] => {
    const rank = new Map<string, number>();
    for (const r of list) {
      const k = firmKey(r);
      if (!k) continue;
      rank.set(k, Math.max(rank.get(k) ?? -Infinity, r.relevance ?? -1));
    }
    const firmRank = (r: Row) => {
      const k = firmKey(r);
      return k ? rank.get(k)! : r.relevance ?? -1;
    };
    return [...list].sort((a, b) => {
      const fr = firmRank(b) - firmRank(a); // firms (and lone contacts) by best rank, desc
      if (fr !== 0) return fr;
      const ka = firmKey(a);
      const kb = firmKey(b);
      if (ka !== kb) return ka.localeCompare(kb); // keep one firm's people together
      return (b.relevance ?? -1) - (a.relevance ?? -1); // best-graded first within the firm
    });
  };
  const sorted = sort
    ? [...filtered].sort((a, b) => {
        const av = sortVal(a, sort.key);
        const bv = sortVal(b, sort.key);
        let c: number;
        if (typeof av === "number" && typeof bv === "number") {
          c = av - bv;
        } else {
          // Date-like string columns (e.g. "Date added" = 6/16/2026) must sort chronologically,
          // not lexically — otherwise 6/16 sorts before 6/2.
          const ad = parseMaybeDate(String(av));
          const bd = parseMaybeDate(String(bv));
          c = ad !== null || bd !== null ? (ad ?? -Infinity) - (bd ?? -Infinity) : String(av).localeCompare(String(bv));
        }
        return sort.dir === "asc" ? c : -c;
      })
    : clusterByFirm(filtered);

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
      const pbd = r.pitchbookData;
      const pb = pbd
        ? col.key === "Region"
          ? pbd["Region"] || pbd["HQ Location"] || pbd["Preferred Geography"]
          : col.key === "Interests"
            ? pbd["Interests"] || pbd["Preferred Industry"] || pbd["Preferred Verticals"]
            : pbd[col.key]
        : undefined;
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
      case "email":
        return r.email ? (
          <a href={`mailto:${r.email}`} className="text-[#2d6cf6] hover:underline" onClick={(e) => e.stopPropagation()}>
            {r.email}
          </a>
        ) : (
          <span className="text-muted">—</span>
        );
      case "linkedin":
        return r.linkedinUrl ? (
          <a
            href={r.linkedinUrl.startsWith("http") ? r.linkedinUrl : `https://${r.linkedinUrl}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#2d6cf6] hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            Profile
          </a>
        ) : (
          <span className="text-muted">—</span>
        );
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
                  <div
                    key={c.key}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-black/[0.03]"
                  >
                    <label className="flex flex-1 cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={visible.includes(c.key)}
                        onChange={() => toggleCol(c.key)}
                      />
                      <span className="text-ink">{labelOf(c)}</span>
                      {c.custom && <span className="text-[10px] text-muted">CSV</span>}
                    </label>
                    <button
                      type="button"
                      title="Rename column"
                      onClick={() => renameCol(c.key, labelOf(c))}
                      className="shrink-0 rounded p-1 text-muted hover:bg-black/[0.06] hover:text-ink"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  </div>
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
                  <span className="inline-flex items-center gap-1">
                    {labelOf(c)}
                    {COLUMN_HELP[c.key] && <InfoTip text={COLUMN_HELP[c.key]} />}
                    {sort?.key === c.key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                  </span>
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
                          <Summary d={d} id={r.id} highValue={!!r.highValue} />
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
