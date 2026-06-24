"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Check, Loader2 } from "lucide-react";

/**
 * Submit button with explicit feedback: spins "Saving…" while the server action runs,
 * then shows "Saved ✓" for a couple seconds so the user knows it persisted.
 * Must be rendered inside the <form> whose action it submits.
 */
export function SaveButton({ children, className }: { children: ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  const [saved, setSaved] = useState(false);
  const [wasPending, setWasPending] = useState(false);

  useEffect(() => {
    if (pending) {
      setWasPending(true);
      setSaved(false);
    } else if (wasPending) {
      setWasPending(false);
      setSaved(true);
      const t = setTimeout(() => setSaved(false), 2500);
      return () => clearTimeout(t);
    }
  }, [pending, wasPending]);

  return (
    <button
      type="submit"
      disabled={pending}
      className={
        className ??
        "flex items-center gap-1.5 rounded-lg bg-black px-4 py-2 text-sm font-medium text-white hover:bg-black/90 disabled:opacity-60"
      }
    >
      {pending ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" /> Saving…
        </>
      ) : saved ? (
        <>
          <Check className="h-4 w-4" /> Saved
        </>
      ) : (
        children
      )}
    </button>
  );
}
