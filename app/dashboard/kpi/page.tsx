import { getKpis, type DayPoint, type Kpi } from "@/lib/kpi/aggregate";
import { getPrimaryUser } from "@/lib/user";

export const dynamic = "force-dynamic";

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
  const kpis = u ? await getKpis(u.id) : [];

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
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {kpis.map((k) => (
            <Card key={k.key} k={k} />
          ))}
        </div>
      )}
    </div>
  );
}
