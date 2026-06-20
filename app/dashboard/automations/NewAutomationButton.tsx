"use client";

import { useState } from "react";
import { createAutomation } from "./actions";

const field =
  "w-full rounded-lg border border-hairline bg-white px-3 py-2 text-sm outline-none focus:border-black/30";

export function NewAutomationButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="shrink-0 rounded-lg bg-black px-3.5 py-2 text-sm font-medium text-white hover:bg-black/90"
      >
        + New automation
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
            <h3 className="text-lg font-semibold text-ink">New automation</h3>
            <form action={createAutomation} className="mt-4 space-y-3">
              <input name="name" required placeholder="Name — e.g. Weekly LP check-in" className={field} />
              <input name="description" placeholder="Short description (optional)" className={field} />
              <label className="block">
                <span className="text-sm font-medium text-ink">Prompt</span>
                <textarea
                  name="prompt"
                  required
                  rows={4}
                  placeholder="What should Dexa do each run? e.g. 'List the 5 highest-relevance investors I haven't contacted in 30+ days, each with a one-line reason and a suggested opener.'"
                  className={field}
                />
              </label>
              <div className="flex gap-3">
                <label className="flex-1">
                  <span className="text-sm font-medium text-ink">Time (daily)</span>
                  <input type="time" name="time" defaultValue="09:00" className={field} />
                </label>
                <label className="flex-1">
                  <span className="text-sm font-medium text-ink">Timezone</span>
                  <input name="timezone" defaultValue="America/New_York" className={field} />
                </label>
              </div>
              <p className="text-xs text-muted">
                Runs daily at the chosen time and delivers to your Telegram. Stays silent if there&apos;s
                nothing worth sending.
              </p>
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
