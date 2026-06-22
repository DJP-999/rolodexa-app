"use client";

import { useState, useTransition } from "react";
import { Star } from "lucide-react";
import { setHighValueAction } from "./actions";

/** Toggle a contact as a VIP (must-watch). VIPs are always news-swept and clear the notification gate. */
export default function VipToggle({ id, initial }: { id: string; initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        const next = !on;
        setOn(next);
        start(async () => {
          await setHighValueAction(id, next);
        });
      }}
      className={
        on
          ? "inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
          : "inline-flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-muted hover:bg-black/[0.03] disabled:opacity-50"
      }
    >
      <Star className="h-3.5 w-3.5" fill={on ? "currentColor" : "none"} />
      {pending ? "Saving..." : on ? "VIP" : "Track as VIP"}
    </button>
  );
}
