import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { suggestions } from "@/db/schema";

export const dynamic = "force-dynamic";

async function getPending() {
  try {
    return await db
      .select()
      .from(suggestions)
      .where(eq(suggestions.status, "pending"))
      .orderBy(desc(suggestions.score))
      .limit(50);
  } catch {
    return null;
  }
}

export default async function SuggestionsPage() {
  const rows = await getPending();
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold">Suggestions</h1>
      <p className="text-sm text-muted">
        Outreach opportunities — gated for precision. Quiet by default.
      </p>

      {!rows ? (
        <p className="mt-6 text-sm text-muted">Connect the database to see suggestions.</p>
      ) : rows.length === 0 ? (
        <p className="mt-6 text-sm text-muted">
          Nothing pending. The gate stays silent until something clears the bar.
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          {rows.map((s) => (
            <div key={s.id} className="card">
              <div className="flex items-center gap-2">
                <span className="chip capitalize">{s.triggerType.replace("_", " ")}</span>
                <span className="chip capitalize">{s.priority}</span>
                <span className="ml-auto text-xs text-muted">
                  {s.score != null ? `${Math.round(s.score * 100)}%` : ""}
                </span>
              </div>
              <p className="mt-2 text-sm">{s.reason}</p>
              {s.draftMessage ? (
                <p className="mt-3 rounded-lg bg-surface p-3 text-sm italic text-muted">
                  {s.draftMessage}
                </p>
              ) : null}
              <div className="mt-3 flex gap-2 text-sm">
                <button className="rounded-lg bg-ink px-3 py-1.5 text-white">Approve</button>
                <button className="rounded-lg border border-hairline px-3 py-1.5">Snooze 7d</button>
                <button className="rounded-lg border border-hairline px-3 py-1.5">Dismiss</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
