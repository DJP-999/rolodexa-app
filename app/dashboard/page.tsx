import { db } from "@/db";
import { contacts } from "@/db/schema";

export const dynamic = "force-dynamic";

async function getStats() {
  try {
    const all = await db.select().from(contacts);
    const total = all.length;
    const enriched = all.filter((c) => c.enrichedAt).length;
    const graded = all.filter((c) => c.relevance != null);
    // FIX vs original: a proper mean over graded contacts (the old app showed "1").
    const avg = graded.length
      ? Math.round(graded.reduce((s, c) => s + (c.relevance ?? 0), 0) / graded.length)
      : 0;
    return { total, enrichedPct: total ? Math.round((enriched / total) * 100) : 0, avg };
  } catch {
    return null;
  }
}

export default async function DashboardHome() {
  const stats = await getStats();
  return (
    <div className="mx-auto max-w-4xl">
      <p className="text-sm text-muted">Dexa</p>
      <h1 className="text-3xl font-bold">How can I help?</h1>

      <div className="card mt-6">
        <input
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted"
          placeholder="Assign a task or ask anything"
        />
      </div>

      {stats ? (
        <div className="mt-6 flex gap-6 text-sm">
          <span>
            <b>{stats.total}</b> <span className="text-muted">Contacts</span>
          </span>
          <span>
            <b>{stats.avg}</b> <span className="text-muted">Avg relevance</span>
          </span>
          <span>
            <b>{stats.enrichedPct}%</b> <span className="text-muted">Enriched</span>
          </span>
        </div>
      ) : (
        <p className="mt-6 text-sm text-muted">
          Database not connected yet — set <code>DATABASE_URL</code> and run{" "}
          <code>npm run db:migrate</code>.
        </p>
      )}

      <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-muted">
        Automations
      </h2>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          ["Morning brief", "7:00 AM"],
          ["Midday update", "12:30 PM"],
          ["Night brief", "8:00 PM"],
        ].map(([n, t]) => (
          <div key={n} className="card bg-gradient-to-br from-dexa to-indigo-500 text-white">
            <div className="font-semibold">{n}</div>
            <div className="mt-1 text-xs opacity-80">{t} · America/New_York</div>
          </div>
        ))}
      </div>
    </div>
  );
}
