"use client";

import { useState, useTransition } from "react";
import { Bell, BellOff } from "lucide-react";
import { setSilencedAction } from "./actions";

/**
 * Silence a contact: mute every outreach nudge/notification for them — for people you're always
 * in touch with or never want pinged about. Toggling off returns them to the normal cadence.
 */
export default function SilenceToggle({ id, initial }: { id: string; initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      title={on ? "Notifications muted — click to unmute" : "Mute all outreach nudges for this contact"}
      onClick={() => {
        const next = !on;
        setOn(next);
        start(async () => {
          await setSilencedAction(id, next);
        });
      }}
      className={
        on
          ? "inline-flex items-center gap-1.5 rounded-lg border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50"
          : "inline-flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-muted hover:bg-black/[0.03] disabled:opacity-50"
      }
    >
      {on ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
      {pending ? "Saving..." : on ? "Silenced" : "Silence"}
    </button>
  );
}
