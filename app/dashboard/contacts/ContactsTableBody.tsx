"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronDown, ArrowRight, Loader2 } from "lucide-react";

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
};

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
  if (r == null) return "#d1d5db";
  if (r >= 70) return "#22c55e";
  return "#f59e0b";
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
          <span className="text-ink">
            {[d.company, d.industry].filter(Boolean).join(" · ") || "—"}
          </span>
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
      {Array.isArray(d.recentNews) && d.recentNews.length > 0 && (
        <div>
          <span className="text-muted">Recent: </span>
          <span className="text-ink">{d.recentNews[0].value}</span>
        </div>
      )}
      <Link
        href={`/dashboard/contacts/${id}`}
        className="inline-flex items-center gap-1 text-[#2d6cf6] hover:underline"
      >
        View full profile <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}

export function ContactsTableBody({ rows }: { rows: Row[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [data, setData] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState<string | null>(null);

  const toggle = async (id: string) => {
    if (open === id) {
      setOpen(null);
      return;
    }
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

  return (
    <tbody>
      {rows.map((c) => {
        const expanded = open === c.id;
        const d = data[c.id];
        return (
          <Fragment key={c.id}>
            <tr className="border-b border-hairline/70 hover:bg-black/[0.015]">
              <td className="px-3 py-3.5">
                <button onClick={() => toggle(c.id)} className="flex items-center gap-3 text-left">
                  <div className="relative">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-black/[0.05] text-xs font-medium text-muted">
                      {c.name.charAt(0).toUpperCase()}
                    </div>
                    <span
                      className={`absolute -bottom-0.5 left-0 h-2.5 w-2.5 rounded-full border-2 border-white ${DOT[c.status ?? "active"]}`}
                    />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-sm font-medium text-ink">
                      {c.name} {c.highValue ? "🔥" : ""}
                      <ChevronDown
                        className={`h-3.5 w-3.5 text-muted transition-transform ${expanded ? "rotate-180" : ""}`}
                      />
                    </div>
                    <div className="text-xs text-muted">{c.role ?? "—"}</div>
                  </div>
                </button>
              </td>
              <td className="px-3 py-3.5 align-top text-[13px] text-muted">{c.company ?? "—"}</td>
              <td className="px-3 py-3.5 align-top text-[13px] text-muted">{c.industry ?? "—"}</td>
              <td className="px-3 py-3.5 align-top text-[13px] text-muted">{c.location ?? "—"}</td>
              <td className="px-3 py-3.5">
                <span
                  className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium capitalize ${REL_BADGE[c.relationship ?? "other"]}`}
                >
                  {c.relationship ?? "other"}
                </span>
              </td>
              <td className="px-3 py-3.5">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-14 overflow-hidden rounded-full bg-hairline">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${c.relevance ?? 0}%`, backgroundColor: meterColor(c.relevance) }}
                    />
                  </div>
                  <span className="text-[13px] font-medium text-ink">{c.relevance ?? "—"}</span>
                </div>
              </td>
              <td className="px-3 py-3.5 text-[13px] font-medium text-emerald-600">{c.lastDays}</td>
            </tr>
            {expanded && (
              <tr className="border-b border-hairline/70 bg-black/[0.015]">
                <td colSpan={7} className="px-5 py-4">
                  {loading === c.id && !d ? (
                    <span className="flex items-center gap-2 text-sm text-muted">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                    </span>
                  ) : d?.ok ? (
                    <Summary d={d} id={c.id} />
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
  );
}
