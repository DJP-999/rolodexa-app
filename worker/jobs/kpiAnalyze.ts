import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { interactions } from "@/db/schema";
import { complete } from "@/lib/llm";
import { selfEmails, upsertCalendarEvent } from "@/lib/sync/track";

const WINDOW_MS = 36 * 60 * 60 * 1000;
const MAX_THREADS = 50;

type Row = typeof interactions.$inferSelect;

function threadKey(r: Row): string {
  return r.threadId || (r.counterpartyEmail ? `cp:${r.counterpartyEmail}` : `id:${r.id}`);
}

/** Read each conversation that saw activity and detect a scheduled meeting the calendar
 *  didn't capture (e.g. "let's do Tuesday 2pm" agreed over email/LinkedIn). */
export async function runKpiAnalyze(): Promise<void> {
  const since = new Date(Date.now() - WINDOW_MS);
  const recent = await db
    .select()
    .from(interactions)
    .where(gte(interactions.occurredAt, since))
    .orderBy(desc(interactions.occurredAt))
    .limit(2000);
  if (!recent.length) {
    console.log("[kpiAnalyze] no recent activity");
    return;
  }

  // Group recent activity into conversations.
  const groups = new Map<string, Row[]>();
  for (const r of recent) {
    if (r.eventType === "meeting") continue;
    const k = `${r.userId}::${threadKey(r)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }

  let detected = 0;
  let analyzed = 0;
  for (const [, rows] of groups) {
    if (analyzed >= MAX_THREADS) break;
    const userId = rows[0].userId;
    const tk = rows[0].threadId;
    const cpEmail = rows[0].counterpartyEmail;

    // Skip if this conversation already has a meeting logged.
    const hasMeeting = (
      await db
        .select({ id: interactions.id })
        .from(interactions)
        .where(
          and(
            eq(interactions.userId, userId),
            eq(interactions.eventType, "meeting"),
            tk ? eq(interactions.threadId, tk) : sql`lower(${interactions.counterpartyEmail}) = ${(cpEmail ?? "").toLowerCase()}`,
          ),
        )
        .limit(1)
    )[0];
    if (hasMeeting) continue;

    // Build a short transcript (chronological).
    const transcript = rows
      .slice(0, 15)
      .reverse()
      .map((r) => {
        const md = (r.metadata ?? {}) as { subject?: string; text?: string };
        const who = r.direction === "outbound" ? "Me" : r.counterpartyName || "Them";
        const body = md.text || md.subject || "";
        return body ? `${who}: ${body}` : null;
      })
      .filter(Boolean)
      .join("\n");
    if (!transcript) continue;
    analyzed++;

    const out = await complete({
      tier: "cheap",
      system:
        "You analyze a sales/outreach conversation. Decide ONLY whether the two parties actually " +
        "agreed to and scheduled a meeting/call (a concrete commitment, not a vague 'let's chat sometime'). " +
        'Respond with strict JSON: {"meetingScheduled": boolean, "when": "ISO8601 date or null"}. No prose.',
      messages: [{ role: "user", content: `Conversation:\n${transcript}\n\nJSON:` }],
      maxTokens: 80,
      temperature: 0,
    });
    if (!out || out.startsWith("[llm-stub")) continue;

    let parsed: { meetingScheduled?: boolean; when?: string | null } | null = null;
    try {
      const m = out.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch {
      /* ignore */
    }
    if (!parsed?.meetingScheduled) continue;

    const whenDate = parsed.when ? new Date(parsed.when) : null;
    const startAt = whenDate && !isNaN(whenDate.getTime()) ? whenDate : new Date(rows[0].occurredAt);
    const self = await selfEmails(userId);
    await upsertCalendarEvent({
      userId,
      sourceRef: `llm-${threadKey(rows[0])}`,
      source: "llm",
      title: "Meeting detected from conversation",
      startAt,
      attendees: cpEmail ? [{ email: cpEmail, name: rows[0].counterpartyName }] : [],
      self,
      contactId: rows[0].contactId ?? null,
    });
    detected++;
  }

  console.log(`[kpiAnalyze] analyzed ${analyzed} conversation(s); detected ${detected} meeting(s)`);
}
