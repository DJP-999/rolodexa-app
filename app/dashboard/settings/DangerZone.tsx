"use client";

import { useState } from "react";
import { resetEnrichmentAction, resetAllDataAction } from "./actions";

export function DangerZone() {
  const [confirm, setConfirm] = useState("");
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-ink">Re-enrich contacts</h3>
        <p className="mt-1 text-xs text-muted">
          Clear all enrichment results, then re-discover and re-enrich every contact from scratch on
          the next run.
        </p>
        <form action={resetEnrichmentAction} className="mt-2">
          <button className="rounded-lg border border-hairline px-3 py-1.5 text-sm hover:bg-black/[0.03]">
            Reset Enrichment
          </button>
        </form>
      </div>

      <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-4">
        <h3 className="text-sm font-semibold text-rose-700">Danger zone</h3>
        <p className="mt-1 text-xs text-rose-700/80">
          Delete all your data — contacts, enrichments, suggestions, connected accounts, chat
          history, message logs, jobs, and context. This cannot be undone.
        </p>
        <form action={resetAllDataAction} className="mt-3 flex flex-wrap items-center gap-2">
          <input
            name="confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Type RESET to confirm"
            className="w-48 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-sm outline-none"
          />
          <button
            disabled={confirm !== "RESET"}
            className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-40"
          >
            Reset All Data
          </button>
        </form>
      </div>
    </div>
  );
}
