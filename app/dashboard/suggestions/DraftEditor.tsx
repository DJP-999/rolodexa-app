"use client";

import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { saveDraftAction } from "./actions";

/** Inline editor for a suggestion's draft message. Edit -> textarea -> Save persists it. */
export default function DraftEditor({
  id,
  initial,
  editable,
}: {
  id: string;
  initial: string;
  editable: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial);
  const [pending, start] = useTransition();

  function save() {
    const fd = new FormData();
    fd.set("id", id);
    fd.set("message", value);
    start(async () => {
      await saveDraftAction(fd);
      setEditing(false);
    });
  }

  return (
    <div className="mt-3 rounded-xl bg-black/[0.03] p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
          Draft message
        </span>
        {editable && !editing && (
          <button
            type="button"
            onClick={() => {
              setValue(initial);
              setEditing(true);
            }}
            className="flex items-center gap-1 text-xs text-muted hover:text-ink"
          >
            <Pencil className="h-3 w-3" /> Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="mt-2">
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={4}
            autoFocus
            className="w-full resize-y rounded-lg border border-hairline bg-white p-2.5 text-sm text-ink outline-none focus:border-black/30"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className="rounded-lg bg-black px-3 py-1.5 text-xs font-medium text-white hover:bg-black/90 disabled:opacity-50"
            >
              {pending ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={pending}
              className="rounded-lg border border-hairline px-3 py-1.5 text-xs hover:bg-black/[0.03]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-2 whitespace-pre-wrap text-sm italic text-muted">{initial}</p>
      )}
    </div>
  );
}
