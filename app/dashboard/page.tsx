import Link from "next/link";
import { AlarmClock, Cable, Plus, ArrowUp, Sparkles, Clock } from "lucide-react";
import { db } from "@/db";
import { contacts } from "@/db/schema";

export const dynamic = "force-dynamic";

async function getStats() {
  try {
    const all = await db.select().from(contacts);
    const total = all.length;
    const enriched = all.filter((c) => c.enrichedAt).length;
    const graded = all.filter((c) => c.relevance != null);
    const avg = graded.length
      ? Math.round(graded.reduce((s, c) => s + (c.relevance ?? 0), 0) / graded.length)
      : 0;
    return { total, enrichedPct: total ? Math.round((enriched / total) * 100) : 0, avg };
  } catch {
    return null;
  }
}

const AUTOMATIONS = [
  { name: "Morning newsletter", time: "7:00 AM" },
  { name: "Midday update", time: "12:30 PM" },
  { name: "Night brief", time: "8:00 PM" },
];

export default async function DashboardHome() {
  const stats = await getStats();
  return (
    <div className="mx-auto max-w-5xl">
      {/* Dexa console */}
      <div className="flex items-start gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="https://relationship-buddy.vercel.app/dexa-mascot.png"
          alt="Dexa"
          className="-mt-2 h-28 w-28 shrink-0 object-contain"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted">Dexa</p>
          <h1 className="text-[40px] font-bold leading-tight tracking-tight">How can I help?</h1>

          <div className="mt-4 rounded-3xl border border-black/[0.06] bg-white/60 p-4 shadow-sm">
            <input
              className="w-full bg-transparent px-1 text-[15px] outline-none placeholder:text-muted"
              placeholder="Assign a task or ask anything"
            />
            <div className="mt-7 flex items-center justify-between">
              <button className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-black/[0.04]">
                <Plus className="h-5 w-5" strokeWidth={2} />
              </button>
              <button className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-100 text-blue-600 transition-colors hover:bg-blue-200">
                <ArrowUp className="h-5 w-5" strokeWidth={2.25} />
              </button>
            </div>
          </div>

          {stats && (
            <div className="mt-4 flex items-center gap-3 text-sm">
              <span>
                <b>{stats.total}</b> <span className="text-muted">Contacts</span>
              </span>
              <span className="text-hairline">|</span>
              <span>
                <b>{stats.avg}</b> <span className="text-muted">Avg relationship score</span>
              </span>
              <span className="text-hairline">|</span>
              <span>
                <b>{stats.enrichedPct}%</b> <span className="text-muted">Enriched</span>
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Automations */}
      <div className="mt-12 flex items-center gap-2.5">
        <AlarmClock className="h-[18px] w-[18px]" strokeWidth={2} />
        <h2 className="text-[15px] font-semibold">Automations</h2>
        <span className="text-hairline">|</span>
        <Link href="/dashboard/automations" className="text-sm text-muted hover:text-ink">
          View all
        </Link>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Link
          href="/dashboard/automations"
          className="flex min-h-[150px] flex-col items-center justify-center rounded-2xl border border-dashed border-black/15 px-4 text-center transition-colors hover:bg-black/[0.02]"
        >
          <Plus className="h-5 w-5 text-muted" />
          <div className="mt-2 text-[15px] font-medium text-ink">New automation</div>
          <div className="mt-0.5 text-xs text-muted">Start from a template or write your own</div>
        </Link>
        {AUTOMATIONS.map((a) => (
          <div
            key={a.name}
            className="relative flex min-h-[150px] flex-col justify-between overflow-hidden rounded-2xl bg-gradient-to-br from-[#4f6ef7] to-[#5a39ef] p-4 text-white shadow-sm"
          >
            <Sparkles className="h-5 w-5 opacity-90" strokeWidth={2} />
            <div>
              <div className="text-xl font-semibold">{a.name}</div>
              <div className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-white/15 px-2 py-1 text-xs">
                <Clock className="h-3.5 w-3.5" />
                {a.time} <span className="opacity-70">Every day</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Connectors */}
      <div className="mt-9 flex items-center gap-2.5">
        <Cable className="h-[18px] w-[18px]" strokeWidth={2} />
        <h2 className="text-[15px] font-semibold">Connectors</h2>
        <span className="text-hairline">|</span>
        <Link href="#" className="text-sm text-muted hover:text-ink">
          View all
        </Link>
      </div>
      <p className="mt-3 text-sm text-muted">
        Coming soon — connect more sources to give the agent richer context.
      </p>
    </div>
  );
}
