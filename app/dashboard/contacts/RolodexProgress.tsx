"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

type Progress = {
  phase: string | null;
  processed: number;
  total: number;
  pct: number;
  etaMs: number;
} | null;

type S = {
  enrichedPct: number;
  fitPct: number;
  running: boolean;
  current: string | null;
  progress: Progress;
};

const PRETTY: Record<string, string> = {
  enrichment: "Enriching",
  "fit-grade": "Scoring fit",
  recompute: "Re-grading",
  "pitchbook-sync": "Matching firms",
  "linkedin-poll": "Syncing LinkedIn",
  "email-poll": "Syncing email",
  "meetings-sync": "Syncing calendar",
  normalize: "Grouping columns",
  "split-contacts": "Splitting rows",
};

function fmtEta(ms: number): string {
  if (!ms || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `~${s}s left`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `~${m}m ${r}s left` : `~${m}m left`;
  const h = Math.floor(m / 60);
  return `~${h}h ${m % 60}m left`;
}

/** Compact, live enrichment progress shown beside the Rolodex title. */
export function RolodexProgress() {
  const [s, setS] = useState<S | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/activity", { cache: "no-store" });
        const j = await r.json();
        if (alive)
          setS({
            enrichedPct: j.progress?.enrichedPct ?? 0,
            fitPct: j.progress?.fitPct ?? 0,
            running: !!j.running,
            current: j.current?.name ?? null,
            progress: j.current?.progress ?? null,
          });
      } catch {
        /* ignore */
      }
    };
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!s) return null;

  const p = s.running ? s.progress : null;
  // When a job reports its own progress, show THAT (live %, count, ETA); else fall back to the
  // static enriched-coverage bar.
  const hasLive = !!p && p.total > 0;
  const barPct = hasLive ? p!.pct : s.enrichedPct;
  const label = s.current ? PRETTY[s.current] ?? "working" : "live";

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
      <div
        className="h-1.5 w-32 overflow-hidden rounded-full bg-black/[0.06]"
        title={hasLive ? `${label}: ${p!.processed}/${p!.total}` : `${s.enrichedPct}% enriched · ${s.fitPct}% fit-graded`}
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-[#4f6ef7] to-[#5a39ef] transition-[width] duration-500"
          style={{ width: `${barPct}%` }}
        />
      </div>

      {hasLive ? (
        <>
          <span className="flex items-center gap-1 text-xs text-[#2d6cf6]">
            <Loader2 className="h-3 w-3 animate-spin" />
            {p!.phase ?? label}
          </span>
          <span className="text-xs text-muted">
            {p!.processed.toLocaleString()} / {p!.total.toLocaleString()} · {p!.pct}%
          </span>
          {p!.etaMs > 0 && <span className="text-xs text-muted">{fmtEta(p!.etaMs)}</span>}
        </>
      ) : (
        <>
          <span className="text-xs text-muted">{s.enrichedPct}% enriched</span>
          {s.running && (
            <span className="flex items-center gap-1 text-xs text-[#2d6cf6]">
              <Loader2 className="h-3 w-3 animate-spin" />
              {label}
            </span>
          )}
        </>
      )}
    </div>
  );
}
