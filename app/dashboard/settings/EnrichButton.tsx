"use client";

import { useState, useTransition } from "react";
import { Loader2, Check } from "lucide-react";
import { enrichNowAction } from "./actions";

/** Interactive "Enrich now" — shows a working state, then a confirmation. */
export function EnrichButton() {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);

  return (
    <div className="flex items-center gap-2">
      {done && !pending && (
        <span className="flex items-center gap-1 text-xs font-medium text-good">
          <Check className="h-3.5 w-3.5" /> Started — running in the background
        </span>
      )}
      <button
        disabled={pending}
        onClick={() =>
          start(async () => {
            setDone(false);
            await enrichNowAction();
            setDone(true);
            setTimeout(() => setDone(false), 8000);
          })
        }
        className="flex items-center gap-1.5 rounded-lg bg-black px-3 py-1.5 text-sm font-medium text-white hover:bg-black/90 disabled:opacity-60"
      >
        {pending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Starting…
          </>
        ) : (
          "Enrich now"
        )}
      </button>
    </div>
  );
}
