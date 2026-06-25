"use client";

import { useEffect, useState } from "react";
import { Activity, Briefcase, CheckCircle2, Loader2, Zap } from "lucide-react";

type Run = { name: string; status: string; startedAt: string | null; finishedAt: string | null };
type Progress = {
  total: number;
  enriched: number;
  scored: number;
  fitGraded: number;
  categorized: number;
  enrichedPct: number;
  scoredPct: number;
  fitPct: number;
  categorizedPct: number;
};
type Data = {
  progress: Progress;
  recent: { gradedLast5m: number; enrichedLast5m: number };
  running: boolean;
  current: { name: string; startedAt: string | null } | null;
  runs: Run[];
  jobChanges: { value: string; at: string | null }[];
  pendingSuggestions: number;
};

const PRETTY: Record<string, string> = {
  enrichment: "Enriching your network",
  "fit-grade": "Scoring domain fit",
  recompute: "Re-grading relevance",
  normalize: "Grouping columns",
  "split-contacts": "Splitting multi-person rows",
  "pitchbook-sync": "Matching PitchBook firms",
  "linkedin-poll": "Syncing LinkedIn",
  "email-poll": "Syncing email",
  "meetings-sync": "Syncing calendar",
  "kpi-analyze": "Reading conversations",
  suggestions: "Generating suggestions",
  "news-scan": "Scanning news",
  "morning-brief": "Morning brief",
  "midday-brief": "Midday update",
  "night-brief": "Night brief",
};
const pretty = (n: string) => PRETTY[n] ?? n.replace(/-/g, " ");

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.max(0, s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}
function elapsed(iso: string | null): string {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function Bar({ label, value, pct, color }: { label: string; value: string; pct: number; color: string }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[13px]">
        <span className="text-ink/80">{label}</span>
        <span className="text-muted">{value}</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-black/[0.06]">
        <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
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
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!d || d.progress.total === 0) return null;

  const { progress, recent, running, current, runs, jobChanges } = d;
  const throughput = recent.gradedLast5m + recent.enrichedLast5m;

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
        {/* Currently running job + live throughput */}
        {running && current ? (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-[#2d6cf6]/20 bg-[#2d6cf6]/[0.04] px-3 py-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-[#2d6cf6]" />
            <span className="font-medium text-ink">{pretty(current.name)}</span>
            <span className="text-muted">· running {elapsed(current.startedAt)}</span>
            {throughput > 0 && (
              <span className="ml-auto flex items-center gap-1 text-xs text-[#2d6cf6]">
                <Zap className="h-3.5 w-3.5" /> {throughput} contacts in the last 5 min
              </span>
            )}
          </div>
        ) : (
          <div className="mb-4 text-sm font-medium text-ink">Network up to date</div>
        )}

        {/* Progress across the rolodex — multiple dimensions */}
        <div className="space-y-3">
          <Bar
            label="Enriched (profiles, news)"
            value={`${progress.enriched.toLocaleString()} / ${progress.total.toLocaleString()} · ${progress.enrichedPct}%`}
            pct={progress.enrichedPct}
            color="linear-gradient(90deg,#4f6ef7,#5a39ef)"
          />
          <Bar
            label="Fit graded (thesis match)"
            value={`${progress.fitGraded.toLocaleString()} / ${progress.total.toLocaleString()} · ${progress.fitPct}%`}
            pct={progress.fitPct}
            color="#16a34a"
          />
          <Bar
            label="Relationship categorized"
            value={`${progress.categorized.toLocaleString()} / ${progress.total.toLocaleString()} · ${progress.categorizedPct}%`}
            pct={progress.categorizedPct}
            color="#f59e0b"
          />
        </div>

        {/* job-change highlights */}
        {jobChanges.length > 0 && (
          <div className="mt-4 space-y-1.5 border-t border-hairline pt-3">
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
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Recent jobs</div>
            <ul className="space-y-1.5 text-sm">
              {runs.slice(0, 8).map((r, i) => (
                <li key={i} className="flex items-center gap-2 text-muted">
                  {r.status === "running" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[#2d6cf6]" />
                  ) : r.status === "failed" ? (
                    <span className="h-2 w-2 rounded-full bg-rose-500" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  )}
                  <span className="text-ink">{pretty(r.name)}</span>
                  <span className="ml-auto text-xs">
                    {r.status === "running" ? "running…" : r.status === "failed" ? "failed" : ago(r.finishedAt ?? r.startedAt)}
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
