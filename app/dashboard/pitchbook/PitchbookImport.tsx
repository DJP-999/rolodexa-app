"use client";

import { importPitchbookAction } from "./actions";

/** File picker that submits the PitchBook CSV to the server action on selection. */
export function PitchbookImport() {
  return (
    <form action={importPitchbookAction}>
      <label className="cursor-pointer rounded-lg bg-black px-3.5 py-2 text-sm font-medium text-white hover:bg-black/90">
        Import PitchBook CSV
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
        />
      </label>
    </form>
  );
}
