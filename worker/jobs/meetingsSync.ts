import { eq } from "drizzle-orm";
import { db } from "@/db";
import { connectedAccounts } from "@/db/schema";
import { isConfigured } from "@/lib/env";
import { listEvents } from "@/lib/integrations/nylas";
import { getCalendarEvents, getCalendars, unipileConfigured } from "@/lib/integrations/unipile";
import { normEmail, selfEmails, upsertCalendarEvent } from "@/lib/sync/track";

const PAST_MS = 45 * 24 * 60 * 60 * 1000;
const FUTURE_MS = 90 * 24 * 60 * 60 * 1000;

type Attendee = { email: string; name: string | null };

/** Mirror every connected-calendar event into calendar_events (links + held/notes outcome). */
export async function runMeetingsSync(): Promise<void> {
  const now = Date.now();
  let n = 0;

  // --- Nylas calendar (dedicated calendar grant) ---
  if (isConfigured("nylas")) {
    const grants = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.provider, "nylas_calendar"));
    for (const g of grants) {
      if (!g.externalId) continue;
      const self = await selfEmails(g.userId);
      const events = await listEvents(
        g.externalId,
        Math.floor((now - PAST_MS) / 1000),
        Math.floor((now + FUTURE_MS) / 1000),
      );
      for (const e of events) {
        const w = e.when ?? {};
        let start: Date | null = null;
        let end: Date | null = null;
        let allDay = false;
        if (w.start_time) {
          start = new Date(w.start_time * 1000);
          if (w.end_time) end = new Date(w.end_time * 1000);
        } else if (w.date || w.start_date) {
          start = new Date(`${w.date ?? w.start_date}T00:00:00Z`);
          allDay = true;
        }
        if (!e.id || !start || isNaN(start.getTime())) continue;
        const attendees: Attendee[] = (e.participants ?? []).map((p) => ({
          email: normEmail(p.email),
          name: p.name ?? null,
        }));
        await upsertCalendarEvent({
          userId: g.userId,
          sourceRef: String(e.id),
          title: e.title ?? null,
          startAt: start,
          endAt: end,
          allDay,
          attendees,
          self,
        });
        n++;
      }
    }
  }

  // --- Unipile calendar (reuses the connected Google/Outlook email grant) ---
  if (unipileConfigured()) {
    const accts = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.provider, "email"));
    for (const g of accts) {
      if (!g.externalId) continue;
      const self = await selfEmails(g.userId);
      const calendars = await getCalendars(g.externalId);
      for (const cal of calendars) {
        const calId = cal?.id ?? cal?.calendar_id;
        if (!calId) continue;
        const events = await getCalendarEvents(g.externalId, String(calId));
        for (const e of events) {
          const id = e?.id ?? e?.event_id;
          const startRaw = e?.start?.date_time ?? e?.start?.dateTime ?? e?.start_time ?? e?.start;
          const endRaw = e?.end?.date_time ?? e?.end?.dateTime ?? e?.end_time ?? e?.end;
          const start = startRaw ? new Date(startRaw) : null;
          if (!id || !start || isNaN(start.getTime())) continue;
          if (start.getTime() < now - PAST_MS || start.getTime() > now + FUTURE_MS) continue;
          const rawAtt: any[] = Array.isArray(e?.attendees)
            ? e.attendees
            : Array.isArray(e?.participants)
              ? e.participants
              : [];
          const attendees: Attendee[] = rawAtt
            .map((a) => ({
              email: normEmail(a?.email ?? a?.identifier ?? a?.address),
              name: typeof a?.display_name === "string" ? a.display_name : typeof a?.name === "string" ? a.name : null,
            }))
            .filter((p) => p.email);
          const end = endRaw ? new Date(endRaw) : null;
          await upsertCalendarEvent({
            userId: g.userId,
            sourceRef: String(id),
            title: typeof e?.title === "string" ? e.title : typeof e?.summary === "string" ? e.summary : null,
            location: typeof e?.location === "string" ? e.location : null,
            startAt: start,
            endAt: end && !isNaN(end.getTime()) ? end : null,
            allDay: !!(e?.all_day ?? e?.is_all_day),
            attendees,
            self,
          });
          n++;
        }
      }
    }
  }

  console.log(`[meetingsSync] mirrored ${n} event(s)`);
}
