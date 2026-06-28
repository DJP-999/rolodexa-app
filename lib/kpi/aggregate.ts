import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, interactions } from "@/db/schema";

const TZ = "America/New_York";
const DAYS = 30;

export type DayPoint = { date: string; value: number };
export type Kpi = { key: string; label: string; today: number; total: number; series: DayPoint[] };

type Raw = { d: string; n: number };

function rowsOf(res: unknown): Raw[] {
  const r = res as { rows?: unknown[] } | unknown[];
  const arr = Array.isArray(r) ? r : (r?.rows ?? []);
  return arr as Raw[];
}

function dayKeyET(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
}
const todayKey = () => dayKeyET(new Date());
const cutoffKey = () => dayKeyET(new Date(Date.now() - (DAYS - 1) * 86_400_000));

/** Fill the last DAYS days (ET) so the chart has a continuous x-axis. */
function fill(map: Map<string, number>): DayPoint[] {
  const out: DayPoint[] = [];
  const now = Date.now();
  for (let i = DAYS - 1; i >= 0; i--) {
    const key = dayKeyET(new Date(now - i * 86_400_000));
    out.push({ date: key, value: map.get(key) ?? 0 });
  }
  return out;
}

// The date-bucket expression. The column name and TZ are fixed constants we control,
// so inlining them with sql.raw is safe (no user input) — and avoids driver type issues.
function dExpr(col: "occurred_at" | "created_at" | "start_at") {
  return sql.raw(`((${col} AT TIME ZONE '${TZ}')::date)`);
}

async function tableKpi(
  table: "interactions" | "calendar_events" | "contacts",
  userId: string,
  key: string,
  label: string,
  cond: ReturnType<typeof sql>,
  dateCol: "occurred_at" | "created_at" | "start_at",
): Promise<Kpi> {
  const empty: Kpi = { key, label, today: 0, total: 0, series: fill(new Map()) };
  try {
    const e = dExpr(dateCol);
    const from = cutoffKey();
    const tbl = sql.raw(table);
    const seriesRes = await db.execute(sql`
      SELECT to_char(${e}, 'YYYY-MM-DD') AS d, count(*)::int AS n
      FROM ${tbl}
      WHERE user_id = ${userId} AND ${cond} AND ${e} >= ${from}::date
      GROUP BY 1
    `);
    const totalRes = await db.execute(sql`
      SELECT count(*)::int AS n FROM ${tbl} WHERE user_id = ${userId} AND ${cond}
    `);
    const map = new Map(rowsOf(seriesRes).map((r) => [r.d, Number(r.n)]));
    const total = Number(rowsOf(totalRes)[0]?.n ?? 0);
    return { key, label, today: map.get(todayKey()) ?? 0, total, series: fill(map) };
  } catch (err) {
    console.error(`[kpi] ${key} failed`, err);
    return empty;
  }
}

/** All KPIs for the user's dashboard. Each is independently fail-safe. */
export async function getKpis(userId: string): Promise<Kpi[]> {
  const [contactsAdded, emailIx, linkedinIx, replies, meetingsSet, meetingsHeld] = await Promise.all([
    tableKpi("contacts", userId, "contactsAdded", "Contacts added", sql`true`, "created_at"),
    tableKpi("interactions", userId, "emailInteractions", "Email interactions", sql`channel = 'nylas_email'`, "occurred_at"),
    tableKpi("interactions", userId, "linkedinInteractions", "LinkedIn interactions", sql`channel = 'linkedin'`, "occurred_at"),
    tableKpi("interactions", userId, "replies", "Replies received", sql`is_reply = true`, "occurred_at"),
    // Set = a meeting with a person was booked (by the day it was synced/detected).
    tableKpi("calendar_events", userId, "meetingsSet", "Meetings set", sql`matched_contact_id IS NOT NULL`, "created_at"),
    // Held = you confirmed it happened, so a meeting that never holds never counts.
    tableKpi("calendar_events", userId, "meetingsHeld", "Meetings held", sql`held = true`, "start_at"),
  ]);
  return [contactsAdded, emailIx, linkedinIx, replies, meetingsSet, meetingsHeld];
}

export type Comm = {
  id: string;
  occurredAt: string;
  channel: string;
  direction: string;
  eventType: string;
  contactId: string;
  contactName: string;
  company: string | null;
  snippet: string | null;
};

/**
 * Every logged communication with a real rolodex contact in the last `days` days (newest first):
 * emails, LinkedIn DMs, and meetings, both directions. Only rows tied to an actual contact.
 */
export async function getRecentCommunications(userId: string, days = 7): Promise<Comm[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  try {
    const rows = await db
      .select({
        id: interactions.id,
        occurredAt: interactions.occurredAt,
        channel: interactions.channel,
        direction: interactions.direction,
        eventType: interactions.eventType,
        metadata: interactions.metadata,
        contactId: contacts.id,
        name: contacts.name,
        company: contacts.company,
      })
      .from(interactions)
      .innerJoin(contacts, eq(interactions.contactId, contacts.id))
      .where(and(eq(interactions.userId, userId), gte(interactions.occurredAt, since)))
      .orderBy(desc(interactions.occurredAt))
      .limit(400);
    return rows.map((r) => {
      const m = (r.metadata ?? {}) as { subject?: string; text?: string };
      const snippet = (typeof m.subject === "string" && m.subject) || (typeof m.text === "string" && m.text) || null;
      return {
        id: r.id,
        occurredAt: new Date(r.occurredAt as unknown as string).toISOString(),
        channel: r.channel ?? "",
        direction: r.direction ?? "",
        eventType: r.eventType,
        contactId: r.contactId,
        contactName: r.name,
        company: r.company,
        snippet: snippet ? snippet.slice(0, 140) : null,
      };
    });
  } catch (err) {
    console.error("[kpi] recent communications failed", err);
    return [];
  }
}
