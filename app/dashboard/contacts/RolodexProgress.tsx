"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

type S = { enrichedPct: number; fitPct: number; running: boolean; current: string | null };

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
          });
      } catch {
        /* ignore */
      }
    };
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!s) return null;

  return (
    <div className="mt-1 flex items-center gap-2">
      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-black/[0.06]" title={`${s.enrichedPct}% enriched · ${s.fitPct}% fit-graded`}>
        <div
          className="h-full rounded-full bg-gradient-to-r from-[#4f6ef7] to-[#5a39ef] transition-[width] duration-700"
          style={{ width: `${s.enrichedPct}%` }}
        />
      </div>
      <span className="text-xs text-muted">{s.enrichedPct}% enriched</span>
      {s.running && (
        <span className="flex items-center gap-1 text-xs text-[#2d6cf6]">
          <Loader2 className="h-3 w-3 animate-spin" />
          {s.current ? PRETTY[s.current] ?? "working" : "live"}
        </span>
      )}
    </div>
  );
}
