"use client";

import { useRef, useState } from "react";
import { Upload, Plus } from "lucide-react";
import { importCsvAction, addContactAction } from "./actions";

const field =
  "w-full rounded-lg border border-hairline bg-white px-3 py-2 text-sm outline-none focus:border-black/30";

export function ContactControls() {
  const [open, setOpen] = useState(false);
  const importForm = useRef<HTMLFormElement>(null);

  return (
    <div className="flex items-center gap-2">
      <form ref={importForm} action={importCsvAction}>
        <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-hairline px-3 py-2 text-sm text-ink hover:bg-black/[0.03]">
          <Upload className="h-4 w-4" /> Import CSV
          <input
            type="file"
            name="file"
            accept=".csv,text/csv"
            hidden
            onChange={() => importForm.current?.requestSubmit()}
          />
        </label>
      </form>

      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-lg bg-black px-3 py-2 text-sm font-medium text-white hover:bg-black/90"
      >
        <Plus className="h-4 w-4" /> Add contact
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-ink">Add contact</h3>
            <form action={addContactAction} className="mt-4 space-y-3">
              <input name="name" required placeholder="Full name *" className={field} />
              <input name="email" type="email" placeholder="Email" className={field} />
              <input name="company" placeholder="Company" className={field} />
              <input name="role" placeholder="Role / title" className={field} />
              <input name="location" placeholder="Location" className={field} />
              <select name="relationship" defaultValue="other" className={field}>
                <option value="investor">Investor</option>
                <option value="coworker">Coworker</option>
                <option value="friend">Friend</option>
                <option value="family">Family</option>
                <option value="vendor">Vendor</option>
                <option value="other">Other</option>
              </select>
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
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
