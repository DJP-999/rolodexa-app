"use client";

import { useTransition } from "react";
import { Trash2 } from "lucide-react";
import { deleteContactAction } from "./actions";

/** Confirm-guarded delete for a contact. Redirects back to the list on success. */
export default function DeleteContactButton({ id, name }: { id: string; name: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (
          window.confirm(
            `Delete ${name}? This permanently removes the contact and its history. This cannot be undone.`,
          )
        ) {
          start(async () => {
            await deleteContactAction(id);
          });
        }
      }}
      className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50"
    >
      <Trash2 className="h-3.5 w-3.5" /> {pending ? "Deleting..." : "Delete"}
    </button>
  );
}
