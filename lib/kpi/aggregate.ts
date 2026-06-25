import { sql } from "drizzle-orm";
import { db } from "@/db";

const TZ = "America/New_York";
const DAYS = 30;

export type DayPoint = { date: string; value: number };
export type Kpi = { key: string; label: string; today: number; total: number; series: DayPoint[] };

type Raw = { d: string; n: number };

function rowsOf(res: unknown): Raw[] {
  const r = res as { rows?: unknown[] } | unknown[];
  const arr = Array.isArray(r) ? r : (r.rows ?? []);
  return arr as Raw[];
}

/** Fill the last DAYS days (ET) so the chart has a continuous x-axis. */
function fill(map: Map<string, number>): DayPoint[] {
  const out: DayPoint[] = [];
  const now = new Date();
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const key = d.toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
    out.push({ date: key, value: map.get(key) ?? 0 });
  }
  return out;
}

/** A KPI over the `interactions` table for a SQL condition fragment. */
async function interactionKpi(
  userId: string,
  key: string,
  label: string,
  cond: ReturnType<typeof sql>,
  dateCol: "occurred_at" | "created_at" = "occurred_at",
): Promise<Kpi> {
  const dateExpr =
    dateCol === "occurred_at"
      ? sql`((occurred_at AT TIME ZONE ${TZ})::date)`
      : sql`((created_at AT TIME ZONE ${TZ})::date)`;
  const seriesRes = await db.execute(sql`
    SELECT to_char(${dateExpr}, 'YYYY-MM-DD') AS d, count(*)::int AS n
    FROM interactions
    WHERE user_id = ${userId} AND ${cond}
      AND ${dateExpr} >= ((now() AT TIME ZONE ${TZ})::date - ${DAYS - 1})
    GROUP BY 1
  `);
  const totalRes = await db.execute(sql`
    SELECT count(*)::int AS n FROM interactions WHERE user_id = ${userId} AND ${cond}
  `);
  const map = new Map(rowsOf(seriesRes).map((r) => [r.d, Number(r.n)]));
  const series = fill(map);
  const total = Number(rowsOf(totalRes)[0]?.n ?? 0);
  const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  return { key, label, today: map.get(todayKey) ?? 0, total, series };
}

/** A KPI over the `calendar_events` table for a SQL condition fragment. */
async function calendarKpi(
  userId: string,
  key: string,
  label: string,
  cond: ReturnType<typeof sql>,
  dateCol: "start_at" | "created_at",
): Promise<Kpi> {
  const dateExpr =
    dateCol === "start_at"
      ? sql`((start_at AT TIME ZONE ${TZ})::date)`
      : sql`((created_at AT TIME ZONE ${TZ})::date)`;
  const seriesRes = await db.execute(sql`
    SELECT to_char(${dateExpr}, 'YYYY-MM-DD') AS d, count(*)::int AS n
    FROM calendar_events
    WHERE user_id = ${userId} AND ${cond}
      AND ${dateExpr} >= ((now() AT TIME ZONE ${TZ})::date - ${DAYS - 1})
    GROUP BY 1
  `);
  const totalRes = await db.execute(sql`
    SELECT count(*)::int AS n FROM calendar_events WHERE user_id = ${userId} AND ${cond}
  `);
  const map = new Map(rowsOf(seriesRes).map((r) => [r.d, Number(r.n)]));
  const total = Number(rowsOf(totalRes)[0]?.n ?? 0);
  const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  return { key, label, today: map.get(todayKey) ?? 0, total, series: fill(map) };
}

/** All KPIs for the user's dashboard. */
export async function getKpis(userId: string): Promise<Kpi[]> {
  // Contacts added (own table).
  const cSeries = await db.execute(sql`
    SELECT to_char(((created_at AT TIME ZONE ${TZ})::date), 'YYYY-MM-DD') AS d, count(*)::int AS n
    FROM contacts
    WHERE user_id = ${userId}
      AND ((created_at AT TIME ZONE ${TZ})::date) >= ((now() AT TIME ZONE ${TZ})::date - ${DAYS - 1})
    GROUP BY 1
  `);
  const cTotal = await db.execute(sql`SELECT count(*)::int AS n FROM contacts WHERE user_id = ${userId}`);
  const cMap = new Map(rowsOf(cSeries).map((r) => [r.d, Number(r.n)]));
  const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const contactsAdded: Kpi = {
    key: "contactsAdded",
    label: "Contacts added",
    today: cMap.get(todayKey) ?? 0,
    total: Number(rowsOf(cTotal)[0]?.n ?? 0),
    series: fill(cMap),
  };

  const [emailIx, linkedinIx, replies, meetingsHeld, meetingsSet] = await Promise.all([
    interactionKpi(userId, "emailInteractions", "Email interactions", sql`channel = 'nylas_email'`),
    interactionKpi(userId, "linkedinInteractions", "LinkedIn interactions", sql`channel = 'linkedin'`),
    interactionKpi(userId, "replies", "Replies received", sql`is_reply = true`),
    // Held = you confirmed it actually happened (so a meeting that never holds doesn't count).
    calendarKpi(userId, "meetingsHeld", "Meetings held", sql`held = true`, "start_at"),
    // Set = a meeting with a person was put on the calendar (by the day it was booked/synced).
    calendarKpi(userId, "meetingsSet", "Meetings set", sql`matched_contact_id IS NOT NULL`, "created_at"),
  ]);

  return [contactsAdded, emailIx, linkedinIx, replies, meetingsSet, meetingsHeld];
}
