"use client";

import { useState, useTransition } from "react";
import { markContactReviewedAction } from "../actions";

/** Dismisses the red "out of date" flag after the user has reviewed/updated their notes. */
export default function MarkReviewedButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  if (done) return null;
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await markContactReviewedAction(id);
          setDone(true);
        })
      }
      className="shrink-0 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-60"
    >
      {pending ? "Marking…" : "Mark reviewed"}
    </button>
  );
}
