import { desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { Sparkles, Check, Clock, X, Pencil, Lightbulb } from "lucide-react";
import { db } from "@/db";
import { suggestions, contacts } from "@/db/schema";
import { approveAction, snoozeAction, dismissAction, generateAction } from "./actions";

export const dynamic = "force-dynamic";

const TRIGGER: Record<string, { glyph: string; label: string }> = {
  re_engage: { glyph: "⏰", label: "Re-engage" },
  job_change: { glyph: "💼", label: "Job Change" },
  milestone: { glyph: "🏆", label: "Milestone" },
};
const PRIORITY: Record<string, string> = {
  high: "bg-rose-100 text-rose-600",
  medium: "bg-amber-100 text-amber-700",
  low: "bg-black/[0.05] text-muted",
};
const TABS: [string, string][] = [
  ["pending", "Pending"],
  ["approved", "Approved"],
  ["snoozed", "Snoozed"],
  ["dismissed", "Dismissed"],
];

async function getData(status: string) {
  try {
    const cond =
      status === "approved"
        ? inArray(suggestions.status, ["approved", "sent"])
        : eq(suggestions.status, status as "pending" | "snoozed" | "dismissed");
    const sug = await db
      .select()
      .from(suggestions)
      .where(cond)
      .orderBy(status === "pending" ? desc(suggestions.score) : desc(suggestions.updatedAt))
      .limit(50);
    const cs = await db.select().from(contacts);
    const map = new Map(cs.map((c) => [c.id, c]));
    return sug.map((s) => ({ ...s, contact: s.contactId ? map.get(s.contactId) : undefined }));
  } catch {
    return null;
  }
}

const EMPTY: Record<string, string> = {
  pending: "Nothing pending. The gate stays silent until something clears the bar.",
  approved: "No approved outreach yet — approve a suggestion to send it.",
  snoozed: "Nothing snoozed.",
  dismissed: "Nothing dismissed.",
};

export default async function SuggestionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const sp = await searchParams;
  const status = ["pending", "approved", "snoozed", "dismissed"].includes(sp.status ?? "")
    ? (sp.status as string)
    : "pending";
  const rows = await getData(status);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight">Suggestions</h1>
          <p className="mt-1 text-sm text-muted">
            AI-generated outreach opportunities for your network.
          </p>
        </div>
        <form action={generateAction}>
          <button className="flex items-center gap-2 rounded-lg bg-black px-3.5 py-2 text-sm font-medium text-white hover:bg-black/90">
            <Sparkles className="h-4 w-4" /> Generate
          </button>
        </form>
      </div>

      <div className="mt-5 flex items-center gap-1 text-sm">
        {TABS.map(([key, label]) => (
          <Link
            key={key}
            href={key === "pending" ? "/dashboard/suggestions" : `/dashboard/suggestions?status=${key}`}
            className={
              status === key
                ? "rounded-full bg-black/[0.06] px-3 py-1 font-medium text-ink"
                : "rounded-full px-3 py-1 text-muted hover:text-ink"
            }
          >
            {label}
          </Link>
        ))}
      </div>

      {!rows ? (
        <p className="mt-8 text-sm text-muted">Connect the database to see suggestions.</p>
      ) : rows.length === 0 ? (
        <p className="mt-8 text-sm text-muted">{EMPTY[status]}</p>
      ) : (
        <div className="mt-5 space-y-4">
          {rows.map((s) => {
            const t = TRIGGER[s.triggerType] ?? { glyph: "•", label: s.triggerType };
            return (
              <div key={s.id} className="card">
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-lg">
                    {t.glyph}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink">{s.contact?.name ?? "Contact"}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${PRIORITY[s.priority ?? "medium"]}`}
                      >
                        {s.priority}
                      </span>
                    </div>
                    <div className="text-xs text-muted">
                      {[s.contact?.role, s.contact?.company].filter(Boolean).join(" · ") || "—"}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs text-muted">
                    <span>{t.label}</span>
                    {s.score != null && <span>{Math.round(s.score * 100)}%</span>}
                  </div>
                </div>

                <p className="mt-3 text-sm text-ink">{s.reason}</p>

                {s.rationale && (
                  <div className="mt-3 rounded-xl border border-amber-200/70 bg-amber-50/60 p-3">
                    <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-700">
                      <Lightbulb className="h-3.5 w-3.5" /> Why now
                    </div>
                    <p className="mt-1 text-sm text-ink/80">{s.rationale}</p>
                  </div>
                )}

                {s.draftMessage && (
                  <div className="mt-3 rounded-xl bg-black/[0.03] p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
                        Draft message
                      </span>
                      <span className="flex items-center gap-1 text-xs text-muted">
                        <Pencil className="h-3 w-3" /> Edit
                      </span>
                    </div>
                    <p className="mt-2 text-sm italic text-muted">{s.draftMessage}</p>
                  </div>
                )}

                {status === "pending" ? (
                  <div className="mt-3 flex items-center gap-2 text-sm">
                    <form action={approveAction}>
                      <input type="hidden" name="id" value={s.id} />
                      <button className="flex items-center gap-1.5 rounded-lg bg-black px-3 py-1.5 font-medium text-white hover:bg-black/90">
                        <Check className="h-4 w-4" /> Approve
                      </button>
                    </form>
                    <form action={snoozeAction}>
                      <input type="hidden" name="id" value={s.id} />
                      <button className="flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 hover:bg-black/[0.03]">
                        <Clock className="h-4 w-4" /> Snooze 7d
                      </button>
                    </form>
                    <form action={dismissAction}>
                      <input type="hidden" name="id" value={s.id} />
                      <button className="flex items-center gap-1.5 px-3 py-1.5 text-muted hover:text-ink">
                        <X className="h-4 w-4" /> Dismiss
                      </button>
                    </form>
                    <span className="ml-auto text-xs text-muted">{s.intentLabel}</span>
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-2 text-xs text-muted">
                    <span className="capitalize">{s.status}</span>
                    <span className="ml-auto">{s.intentLabel}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
