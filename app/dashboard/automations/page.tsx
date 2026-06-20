import { eq } from "drizzle-orm";
import { Play, Pause, Trash2 } from "lucide-react";
import { db } from "@/db";
import { automations } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { NewAutomationButton } from "./NewAutomationButton";
import { toggleAutomation, deleteAutomation, runAutomationNow } from "./actions";

export const dynamic = "force-dynamic";

const BUILTINS = [
  {
    name: "Morning newsletter",
    slug: "morning-newsletter",
    desc: "A 7 AM daily brief about your contacts, pending suggestions, and what to act on today.",
    schedule: "Every day at 7:00 AM",
  },
  {
    name: "Midday update",
    slug: "midday-update",
    desc: "A 12:30 PM delta brief — only what changed since the morning. Silent when nothing did.",
    schedule: "Every day at 12:30 PM",
  },
  {
    name: "Night brief",
    slug: "night-brief",
    desc: "An 8 PM recap of what happened today, what's open, and a preview of tomorrow.",
    schedule: "Every day at 8:00 PM",
  },
];

function cronLabel(cron: string): string {
  const [m, h] = cron.split(" ");
  const hh = parseInt(h, 10);
  const mm = parseInt(m, 10);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return cron;
  const ampm = hh >= 12 ? "PM" : "AM";
  const h12 = ((hh + 11) % 12) + 1;
  return `Every day at ${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
}

async function getCustom() {
  try {
    const u = await getPrimaryUser();
    if (!u) return [];
    return await db.select().from(automations).where(eq(automations.userId, u.id));
  } catch {
    return [];
  }
}

export default async function AutomationsPage() {
  const custom = await getCustom();

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight">Automations</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Recurring tasks the agent runs on your behalf. Write a prompt; the schedule fires Dexa
            with your real network context and delivers the result to Telegram.
          </p>
        </div>
        <NewAutomationButton />
      </div>

      {custom.length > 0 && (
        <div className="mt-6 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Yours</h2>
          {custom.map((a) => (
            <div key={a.id} className="card">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-semibold">{a.name}</h3>
                    <span
                      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${
                        a.enabled ? "bg-emerald-50 text-emerald-600" : "bg-black/[0.05] text-muted"
                      }`}
                    >
                      {a.enabled ? "active" : "paused"}
                    </span>
                    {a.lastRunStatus && (
                      <span className="chip">Last run: {a.lastRunStatus}</span>
                    )}
                  </div>
                  {a.description && <p className="mt-1 text-sm text-muted">{a.description}</p>}
                  <p className="mt-2 line-clamp-2 text-sm text-ink/80">{a.prompt}</p>
                  <p className="mt-2 text-xs text-muted">
                    {cronLabel(a.cron)} · {a.timezone}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1 text-muted">
                  <form action={runAutomationNow}>
                    <input type="hidden" name="id" value={a.id} />
                    <button
                      title="Run now"
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-hairline hover:bg-black/[0.03]"
                    >
                      <Play className="h-4 w-4" />
                    </button>
                  </form>
                  <form action={toggleAutomation}>
                    <input type="hidden" name="id" value={a.id} />
                    <button
                      title={a.enabled ? "Pause" : "Resume"}
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-hairline hover:bg-black/[0.03]"
                    >
                      <Pause className="h-4 w-4" />
                    </button>
                  </form>
                  <form action={deleteAutomation}>
                    <input type="hidden" name="id" value={a.id} />
                    <button
                      title="Delete"
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-hairline text-rose-500 hover:bg-rose-50"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </form>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Built-in briefs</h2>
        {BUILTINS.map((a) => (
          <div key={a.slug} className="card">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold">{a.name}</h3>
              <span className="chip">system</span>
              <span className="inline-flex items-center rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-600">
                active
              </span>
            </div>
            <p className="mt-2 text-sm text-muted">{a.desc}</p>
            <p className="mt-2 text-xs text-muted">{a.schedule} · America/New_York</p>
          </div>
        ))}
      </div>
    </div>
  );
}
