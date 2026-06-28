import Link from "next/link";
import { getKpis, getRecentCommunications, type Comm, type DayPoint, type Kpi } from "@/lib/kpi/aggregate";
import { getPrimaryUser } from "@/lib/user";

export const dynamic = "force-dynamic";

const CHANNEL: Record<string, { label: string; cls: string }> = {
  nylas_email: { label: "Email", cls: "bg-blue-50 text-blue-700" },
  linkedin: { label: "LinkedIn", cls: "bg-sky-50 text-sky-700" },
  nylas_calendar: { label: "Meeting", cls: "bg-amber-50 text-amber-700" },
  telegram: { label: "Telegram", cls: "bg-violet-50 text-violet-700" },
  imessage: { label: "iMessage", cls: "bg-emerald-50 text-emerald-700" },
};

function CommRow({ c }: { c: Comm }) {
  const ch = CHANNEL[c.channel] ?? { label: c.channel || "—", cls: "bg-black/[0.05] text-muted" };
  const time = new Date(c.occurredAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const dir = c.eventType === "meeting" ? "Met with" : c.direction === "outbound" ? "You →" : "→ You";
  return (
    <div className="flex items-start gap-3 px-4 py-2.5 text-sm">
      <span className="w-14 shrink-0 pt-0.5 text-xs text-muted">{time}</span>
      <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${ch.cls}`}>{ch.label}</span>
      <div className="min-w-0 flex-1">
        <Link href={`/dashboard/contacts/${c.contactId}`} className="font-medium text-ink hover:underline">
          {c.contactName}
        </Link>
        {c.company && <span className="text-muted"> · {c.company}</span>}
        <span className="text-muted"> — {dir}</span>
        {c.snippet && <span className="text-muted"> {c.snippet}</span>}
      </div>
    </div>
  );
}

const COLORS: Record<string, string> = {
  contactsAdded: "#6366f1",
  emailInteractions: "#2d6cf6",
  linkedinInteractions: "#0a66c2",
  replies: "#16a34a",
  meetingsSet: "#f59e0b",
  meetingsHeld: "#9333ea",
};

function Bars({ series, color }: { series: DayPoint[]; color: string }) {
  const w = 320;
  const h = 56;
  const max = Math.max(1, ...series.map((s) => s.value));
  const bw = w / series.length;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-3 h-14 w-full" preserveAspectRatio="none">
      {series.map((s, i) => {
        const bh = s.value === 0 ? 1 : Math.max(2, (s.value / max) * (h - 6));
        return (
          <rect
            key={s.date}
            x={i * bw + 1}
            y={h - bh}
            width={Math.max(1, bw - 1.5)}
            height={bh}
            rx={1}
            fill={color}
            opacity={s.value === 0 ? 0.18 : 0.85}
          >
            <title>{`${s.date}: ${s.value}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function Card({ k }: { k: Kpi }) {
  const color = COLORS[k.key] ?? "#6366f1";
  const last7 = k.series.slice(-7).reduce((a, b) => a + b.value, 0);
  return (
    <div className="rounded-2xl border border-hairline bg-white p-5">
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-muted">{k.label}</span>
        <span className="text-[11px] text-muted">{k.total.toLocaleString()} all-time</span>
      </div>
      <div className="mt-2 flex items-end gap-2">
        <span className="text-[34px] font-bold leading-none tracking-tight" style={{ color }}>
          {k.today}
        </span>
        <span className="pb-1 text-xs text-muted">today · {last7} last 7d</span>
      </div>
      <Bars series={k.series} color={color} />
    </div>
  );
}

export default async function KpiPage() {
  const u = await getPrimaryUser();
  const [kpis, comms] = u
    ? await Promise.all([getKpis(u.id), getRecentCommunications(u.id, 7)])
    : [[] as Kpi[], [] as Comm[]];

  // Group communications by ET day, newest first (insertion order preserved).
  const byDay = new Map<string, Comm[]>();
  for (const c of comms) {
    const day = new Date(c.occurredAt).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "America/New_York",
    });
    const list = byDay.get(day);
    if (list) list.push(c);
    else byDay.set(day, [c]);
  }
  const uniqueContacts = new Set(comms.map((c) => c.contactId)).size;

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-[28px] font-bold tracking-tight">KPI Tracking</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Daily activity across your network — captured automatically from your email, LinkedIn, and
        calendar. Each chart shows the last 30 days (ET).
      </p>

      {!u ? (
        <p className="mt-8 text-sm text-muted">Connect the database to see your KPIs.</p>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {kpis.map((k) => (
              <Card key={k.key} k={k} />
            ))}
          </div>

          <section className="mt-10">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold tracking-tight">Communications · last 7 days</h2>
              <span className="text-xs text-muted">
                {comms.length} touchpoint{comms.length === 1 ? "" : "s"} · {uniqueContacts} contact
                {uniqueContacts === 1 ? "" : "s"}
              </span>
            </div>

            {comms.length === 0 ? (
              <p className="mt-3 text-sm text-muted">
                No communications logged with your rolodex in the last 7 days.
              </p>
            ) : (
              <div className="mt-4 space-y-6">
                {[...byDay.entries()].map(([day, list]) => (
                  <div key={day}>
                    <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
                      {day}
                    </div>
                    <div className="mt-2 divide-y divide-hairline rounded-2xl border border-hairline bg-white">
                      {list.map((c) => (
                        <CommRow key={c.id} c={c} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
