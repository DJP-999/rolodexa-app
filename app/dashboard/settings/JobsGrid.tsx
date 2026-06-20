"use client";

import { useState, useTransition } from "react";
import { Loader2, Play } from "lucide-react";
import { runJobAction } from "./actions";

export type Job = {
  name: string;
  label: string;
  schedule: string;
  lastRun: string | null;
  status: string | null;
};

function ago(iso: string | null): string {
  if (!iso) return "Never run";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function JobsGrid({ jobs }: { jobs: Job[] }) {
  const [pending, start] = useTransition();
  const [running, setRunning] = useState<string | null>(null);

  const run = (job: string) =>
    start(async () => {
      setRunning(job);
      const fd = new FormData();
      fd.set("job", job);
      await runJobAction(fd);
      setRunning(null);
    });

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">Run on demand or wait for the schedule.</span>
        <button
          onClick={() => run("enrichment")}
          disabled={pending}
          className="rounded-lg border border-hairline px-3 py-1.5 text-sm hover:bg-black/[0.03] disabled:opacity-50"
        >
          Re-run All
        </button>
      </div>
      <ul className="mt-3 divide-y divide-hairline">
        {jobs.map((j) => (
          <li key={j.name} className="flex items-center justify-between gap-3 py-2.5 text-sm">
            <div className="min-w-0">
              <div className="font-medium text-ink">{j.label}</div>
              <div className="text-xs text-muted">
                {ago(j.lastRun)} · {j.schedule}
                {j.status ? ` · ${j.status}` : ""}
              </div>
            </div>
            <button
              onClick={() => run(j.name)}
              disabled={pending}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 hover:bg-black/[0.03] disabled:opacity-50"
            >
              {running === j.name && pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Run Now
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
