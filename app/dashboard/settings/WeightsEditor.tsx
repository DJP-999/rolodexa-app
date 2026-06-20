"use client";

import { useState } from "react";
import { saveWeights } from "./actions";

const FIELDS: [string, string, string][] = [
  ["professional", "Professional Relevance", "How well a contact's field matches your active projects"],
  ["recency", "Recency Decay", "Priority based on how long since you last connected"],
  ["relationship", "Relationship Strength", "Score based on interaction frequency and depth"],
  ["geographic", "Geographic Proximity", "Higher score for contacts in the same region"],
  ["trigger", "Trigger Urgency", "How much weight the trigger type itself carries"],
];
const COLORS: Record<string, string> = {
  professional: "#4f6ef7",
  recency: "#22c55e",
  relationship: "#f59e0b",
  geographic: "#a855f7",
  trigger: "#ef4444",
};

export function WeightsEditor({ initial }: { initial: Record<string, number> }) {
  const [w, setW] = useState<Record<string, number>>({
    professional: initial.professional ?? 30,
    recency: initial.recency ?? 25,
    relationship: initial.relationship ?? 20,
    geographic: initial.geographic ?? 15,
    trigger: initial.trigger ?? 10,
  });
  const total = FIELDS.reduce((s, [k]) => s + (w[k] || 0), 0) || 1;

  return (
    <form action={saveWeights} className="space-y-4">
      {FIELDS.map(([k, label, desc]) => (
        <div key={k}>
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-ink">{label}</span>
            <span className="text-muted">{Math.round((w[k] / total) * 100)}%</span>
          </div>
          <div className="text-xs text-muted">{desc}</div>
          <input
            type="range"
            name={k}
            min={0}
            max={50}
            value={w[k]}
            onChange={(e) => setW((s) => ({ ...s, [k]: Number(e.target.value) }))}
            className="mt-1.5 w-full accent-black"
          />
        </div>
      ))}

      <div>
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
          Weight distribution
        </div>
        <div className="mt-2 flex h-3 w-full overflow-hidden rounded-full bg-black/[0.06]">
          {FIELDS.map(([k]) => (
            <div key={k} style={{ width: `${(w[k] / total) * 100}%`, backgroundColor: COLORS[k] }} />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {FIELDS.map(([k, label]) => (
            <span key={k} className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: COLORS[k] }} />
              {label.split(" ")[0]}
            </span>
          ))}
        </div>
      </div>

      <div className="flex justify-end">
        <button className="rounded-lg bg-black px-4 py-2 text-sm font-medium text-white hover:bg-black/90">
          Save weights
        </button>
      </div>
    </form>
  );
}
