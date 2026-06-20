"use client";

import { useEffect, useState } from "react";
import { Activity, Briefcase, CheckCircle2, Loader2 } from "lucide-react";

type Run = { name: string; status: string; startedAt: string | null; finishedAt: string | null };
type Data = {
  progress: { total: number; enriched: number; graded: number; pct: number };
  running: boolean;
  runs: Run[];
  jobChanges: { value: string; at: string | null }[];
  pendingSuggestions: number;
};

const PRETTY: Record<string, string> = {
  enrichment: "Enriching your network",
  recompute: "Re-grading relevance",
  suggestions: "Generating suggestions",
  "email-poll": "Syncing email",
  "morning-brief": "Morning brief",
  "midday-brief": "Midday update",
  "night-brief": "Night brief",
};

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.max(0, s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function ActivityPanel() {
  const [d, setD] = useState<Data | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/activity", { cache: "no-store" });
        const j = (await r.json()) as Data;
        if (alive) setD(j);
      } catch {
        /* ignore transient errors */
      }
    };
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!d || d.progress.total === 0) return null;

  const { progress, running, runs, jobChanges } = d;

  return (
    <div className="mt-9">
      <div className="flex items-center gap-2.5">
        <Activity className="h-[18px] w-[18px]" strokeWidth={2} />
        <h2 className="text-[15px] font-semibold">Activity</h2>
        {running && (
          <span className="flex items-center gap-1 text-xs text-[#2d6cf6]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> live
          </span>
        )}
      </div>

      <div className="mt-4 rounded-2xl border border-hairline bg-white p-5">
        {/* enrichment progress */}
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium text-ink">
            {running ? "Dexa is enriching your network" : "Network enriched"}
          </span>
          <span className="text-muted">
            {progress.enriched} of {progress.total} · {progress.pct}%
          </span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-black/[0.06]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[#4f6ef7] to-[#5a39ef] transition-[width] duration-700"
            style={{ width: `${progress.pct}%` }}
          />
        </div>

        {/* job-change highlights */}
        {jobChanges.length > 0 && (
          <div className="mt-4 space-y-1.5">
            {jobChanges.slice(0, 3).map((j, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <Briefcase className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <span className="text-ink">{j.value}</span>
                <span className="ml-auto shrink-0 text-xs text-muted">{ago(j.at)}</span>
              </div>
            ))}
          </div>
        )}

        {/* recent job runs */}
        {runs.length > 0 && (
          <div className="mt-4 border-t border-hairline pt-3">
            <ul className="space-y-1.5 text-sm">
              {runs.slice(0, 5).map((r, i) => (
                <li key={i} className="flex items-center gap-2 text-muted">
                  {r.status === "running" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[#2d6cf6]" />
                  ) : r.status === "failed" ? (
                    <span className="h-2 w-2 rounded-full bg-rose-500" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  )}
                  <span className="text-ink">{PRETTY[r.name] ?? r.name}</span>
                  <span className="ml-auto text-xs">
                    {r.status === "running" ? "running…" : ago(r.finishedAt ?? r.startedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
