"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, X } from "lucide-react";
import { updateContactAction } from "../actions";

type Values = {
  name: string;
  email: string;
  company: string;
  role: string;
  location: string;
  industry: string;
  linkedinUrl: string;
  relationship: string;
  summary: string;
};

const REL = ["investor", "friend", "coworker", "vendor", "family", "other"];
const inputCls =
  "mt-1 w-full rounded-lg border border-hairline bg-white px-3 py-2 text-sm outline-none focus:border-black/30";

export default function ContactEditForm({ id, initial }: { id: string; initial: Values }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<Values>(initial);
  const [pending, start] = useTransition();

  const field = (k: keyof Values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setV((s) => ({ ...s, [k]: e.target.value }));

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setV(initial);
          setOpen(true);
        }}
        className="inline-flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-black/[0.03]"
      >
        <Pencil className="h-3.5 w-3.5" /> Edit
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-6" onClick={() => setOpen(false)}>
      <div
        className="mt-10 w-full max-w-lg rounded-2xl border border-hairline bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-ink">Edit contact</h3>
          <button onClick={() => setOpen(false)} className="rounded p-1 text-muted hover:bg-black/[0.05]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium text-muted">
            Name
            <input value={v.name} onChange={field("name")} className={inputCls} />
          </label>
          <label className="block text-xs font-medium text-muted">
            Email
            <input value={v.email} onChange={field("email")} className={inputCls} />
          </label>
          <label className="block text-xs font-medium text-muted">
            Company
            <input value={v.company} onChange={field("company")} className={inputCls} />
          </label>
          <label className="block text-xs font-medium text-muted">
            Role
            <input value={v.role} onChange={field("role")} className={inputCls} />
          </label>
          <label className="block text-xs font-medium text-muted">
            Location
            <input value={v.location} onChange={field("location")} className={inputCls} />
          </label>
          <label className="block text-xs font-medium text-muted">
            Industry
            <input value={v.industry} onChange={field("industry")} className={inputCls} />
          </label>
          <label className="block text-xs font-medium text-muted">
            LinkedIn URL
            <input value={v.linkedinUrl} onChange={field("linkedinUrl")} className={inputCls} />
          </label>
          <label className="block text-xs font-medium text-muted">
            Relationship
            <select value={v.relationship} onChange={field("relationship")} className={`${inputCls} capitalize`}>
              {REL.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="mt-3 block text-xs font-medium text-muted">
          About / summary
          <textarea value={v.summary} onChange={field("summary")} rows={4} className={inputCls} />
        </label>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-ink">
            Cancel
          </button>
          <button
            disabled={pending}
            onClick={() =>
              start(async () => {
                await updateContactAction(id, v);
                setOpen(false);
                router.refresh();
              })
            }
            className="rounded-lg bg-black px-4 py-1.5 text-sm font-medium text-white hover:bg-black/90 disabled:opacity-60"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
