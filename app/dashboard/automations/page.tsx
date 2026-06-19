import { Play, Pause, Pencil, Trash2 } from "lucide-react";

export const dynamic = "force-dynamic";

const AUTOMATIONS = [
  {
    name: "Night brief",
    slug: "night-brief",
    desc: "An 8 PM recap of what happened today, what's still open, and a preview of tomorrow.",
    schedule: "Every day at 8:00 PM",
    next: "8:00 PM",
  },
  {
    name: "Midday update",
    slug: "midday-update",
    desc: "A 12:30 PM delta brief — only what changed since the morning. Stays silent when nothing did.",
    schedule: "Every day at 12:30 PM",
    next: "12:30 PM",
  },
  {
    name: "Morning newsletter",
    slug: "morning-newsletter",
    desc: "A 7 AM daily brief about your contacts, pending suggestions, and what to act on today.",
    schedule: "Every day at 7:00 AM",
    next: "7:00 AM",
  },
];

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-ink">{value}</div>
    </div>
  );
}

export default function AutomationsPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight">Automations</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Recurring tasks the agent runs on your behalf. Edit the prompt to change what the brief
            looks like — the schedule fires the agent with that prompt and lets it do the rest.
          </p>
        </div>
        <button className="shrink-0 rounded-lg bg-black px-3.5 py-2 text-sm font-medium text-white">
          + New automation
        </button>
      </div>

      <div className="mt-6 space-y-4">
        {AUTOMATIONS.map((a) => (
          <div key={a.slug} className="card">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold">{a.name}</h3>
                <span className="chip">{a.slug}</span>
                <span className="inline-flex items-center rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-600">
                  Last run: delivered:telegram
                </span>
              </div>
              <div className="flex items-center gap-1 text-muted">
                {[Play, Pause, Pencil].map((Icon, i) => (
                  <button
                    key={i}
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-hairline hover:bg-black/[0.03]"
                  >
                    <Icon className="h-4 w-4" />
                  </button>
                ))}
                <button className="flex h-8 w-8 items-center justify-center rounded-lg border border-hairline text-rose-500 hover:bg-rose-50">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
            <p className="mt-2 text-sm text-muted">{a.desc}</p>
            <div className="mt-4 grid grid-cols-3 gap-4">
              <Meta label="Schedule" value={a.schedule} />
              <Meta label="Timezone" value="America/New_York" />
              <Meta label="Next run" value={a.next} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
