"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";

type Progress = { phase: string | null; processed: number; total: number; pct: number; etaMs: number } | null;
type S = { running: boolean; name: string | null; progress: Progress };

const PRETTY: Record<string, string> = {
  "fit-grade": "Scoring fit & relevance",
  "personal-profile": "Learning personal details",
  recompute: "Re-grading relevance",
  enrichment: "Enriching your network",
  "apify-enrich": "Pulling LinkedIn profiles",
  "apify-resolve": "Finding LinkedIn URLs",
  "message-backfill": "Backfilling message history",
  "pitchbook-sync": "Matching firms",
  normalize: "Grouping columns",
  "split-contacts": "Splitting multi-person rows",
  suggestions: "Generating suggestions",
  "follow-through": "Checking replies & follow-ups",
  "news-scan": "Scanning news",
  "morning-brief": "Morning brief",
  "midday-brief": "Midday update",
  "night-brief": "Night brief",
  reminders: "Sending due reminders",
  "email-poll": "Syncing email",
  "linkedin-poll": "Syncing LinkedIn",
  "meetings-sync": "Syncing calendar",
};

function fmtEta(ms: number): string {
  if (!ms || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `~${s}s left`;
  const m = Math.floor(s / 60);
  return m < 60 ? (s % 60 ? `~${m}m ${s % 60}s left` : `~${m}m left`) : `~${Math.floor(m / 60)}h ${m % 60}m left`;
}

/**
 * Live status of background work — so after a Save (which kicks off a re-grade) or a Run Now, the
 * user actually sees what's happening and its progress, instead of wondering if anything occurred.
 * Polls the shared activity endpoint every 2s.
 */
export function LiveJobStatus() {
  const [s, setS] = useState<S | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const j = await fetch("/api/activity", { cache: "no-store" }).then((r) => r.json());
        if (alive) setS({ running: !!j.running, name: j.current?.name ?? null, progress: j.current?.progress ?? null });
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

  if (!s.running) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-xl border border-hairline bg-black/[0.02] px-3 py-2 text-sm text-muted">
        <CheckCircle2 className="h-4 w-4 text-emerald-500" /> All background work is up to date.
      </div>
    );
  }

  const label = s.name ? PRETTY[s.name] ?? s.name.replace(/-/g, " ") : "Working";
  const p = s.progress;
  return (
    <div className="mb-3 rounded-xl border border-[#2d6cf6]/20 bg-[#2d6cf6]/[0.05] px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin text-[#2d6cf6]" />
        <span className="font-medium text-ink">{label}</span>
        {p?.phase && <span className="text-muted">· {p.phase}</span>}
        {p && p.total > 0 && (
          <span className="ml-auto text-xs text-muted">
            {p.processed.toLocaleString()} / {p.total.toLocaleString()} · {p.pct}%
            {p.etaMs > 0 ? ` · ${fmtEta(p.etaMs)}` : ""}
          </span>
        )}
      </div>
      {p && p.total > 0 && (
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-black/[0.06]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[#4f6ef7] to-[#5a39ef] transition-[width] duration-500"
            style={{ width: `${p.pct}%` }}
          />
        </div>
      )}
    </div>
  );
}
