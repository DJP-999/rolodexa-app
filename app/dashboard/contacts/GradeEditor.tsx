"use client";

import { useState, useTransition } from "react";
import { setManualGradesAction } from "./actions";

/**
 * Manually set a contact's Fit % and Relevance. Saving LOCKS the values so auto grading and the
 * nightly recompute never overwrite them; "Reset to Auto" releases the lock and re-grades.
 */
export default function GradeEditor({
  id,
  fit,
  relevance,
  locked,
}: {
  id: string;
  fit: number;
  relevance: number;
  locked: boolean;
}) {
  const [f, setF] = useState(String(fit));
  const [r, setR] = useState(String(relevance));
  const [isLocked, setLocked] = useState(locked);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      await setManualGradesAction(id, { fit: Number(f), relevance: Number(r) });
      setLocked(true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });

  const auto = () =>
    start(async () => {
      await setManualGradesAction(id, { auto: true });
      setLocked(false);
      setSaved(false);
    });

  return (
    <div className="mt-4 rounded-xl border border-hairline bg-black/[0.02] p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Manual override</span>
        {isLocked && (
          <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-700">
            Locked · manual
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="text-xs text-muted">
          Fit %
          <input
            type="number"
            min={0}
            max={100}
            value={f}
            onChange={(e) => setF(e.target.value)}
            className="mt-1 block w-20 rounded-lg border border-hairline px-2 py-1 text-sm text-ink outline-none focus:border-black/40"
          />
        </label>
        <label className="text-xs text-muted">
          Relevance
          <input
            type="number"
            min={0}
            max={100}
            value={r}
            onChange={(e) => setR(e.target.value)}
            className="mt-1 block w-20 rounded-lg border border-hairline px-2 py-1 text-sm text-ink outline-none focus:border-black/40"
          />
        </label>
        <button
          onClick={save}
          disabled={pending}
          className="rounded-lg bg-black px-3 py-1.5 text-xs font-medium text-white hover:bg-black/90 disabled:opacity-50"
        >
          {pending ? "Saving…" : saved ? "Saved ✓" : "Save & lock"}
        </button>
        {isLocked && (
          <button
            onClick={auto}
            disabled={pending}
            className="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-muted hover:bg-black/[0.03] disabled:opacity-50"
          >
            Reset to Auto
          </button>
        )}
      </div>
      <p className="mt-2 text-[11px] text-muted">
        Saving pins these values — auto grading won&rsquo;t change them until you reset to Auto.
      </p>
    </div>
  );
}
