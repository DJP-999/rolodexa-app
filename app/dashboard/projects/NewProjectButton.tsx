"use client";

import { useState } from "react";
import { createProject } from "./actions";

const field =
  "w-full rounded-lg border border-hairline bg-white px-3 py-2 text-sm outline-none focus:border-black/30";

export function NewProjectButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg bg-black px-3.5 py-2 text-sm font-medium text-white hover:bg-black/90"
      >
        + New project
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-ink">New project</h3>
            <form action={createProject} className="mt-4 space-y-3">
              <input name="name" required placeholder="Project name — e.g. Healthcare roll-up SPV" className={field} />
              <input name="oneLiner" placeholder="One-liner (optional)" className={field} />
              <label className="block">
                <span className="text-sm font-medium text-ink">Memory / notes</span>
                <textarea
                  name="memoryDoc"
                  rows={4}
                  placeholder="Context Dexa should remember: targets, status, key people, next steps…"
                  className={field}
                />
              </label>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-lg px-3 py-2 text-sm text-muted hover:text-ink"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-black px-4 py-2 text-sm font-medium text-white hover:bg-black/90"
                >
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
