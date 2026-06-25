import { and, between, eq } from "drizzle-orm";
import { db } from "@/db";
import { calendarEvents, contacts } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { CalendarWeek, type EventVM } from "./CalendarWeek";

export const dynamic = "force-dynamic";

async function getEvents(userId: string): Promise<EventVM[]> {
  const from = new Date(Date.now() - 21 * 86_400_000);
  const to = new Date(Date.now() + 70 * 86_400_000);
  try {
    const rows = await db
      .select({
        id: calendarEvents.id,
        title: calendarEvents.title,
        location: calendarEvents.location,
        startAt: calendarEvents.startAt,
        endAt: calendarEvents.endAt,
        allDay: calendarEvents.allDay,
        attendees: calendarEvents.attendees,
        held: calendarEvents.held,
        notes: calendarEvents.notes,
        matchedContactId: calendarEvents.matchedContactId,
        coldProspectId: calendarEvents.coldProspectId,
        contactName: contacts.name,
      })
      .from(calendarEvents)
      .leftJoin(contacts, eq(contacts.id, calendarEvents.matchedContactId))
      .where(and(eq(calendarEvents.userId, userId), between(calendarEvents.startAt, from, to)))
      .orderBy(calendarEvents.startAt)
      .limit(2000);
    return rows.map((r) => ({
      id: r.id,
      title: r.title || "(no title)",
      location: r.location,
      startISO: new Date(r.startAt).toISOString(),
      endISO: r.endAt ? new Date(r.endAt).toISOString() : null,
      allDay: !!r.allDay,
      attendees: (r.attendees ?? []) as { email: string; name: string | null }[],
      held: r.held,
      notes: r.notes,
      contactId: r.matchedContactId,
      coldProspectId: r.coldProspectId,
      contactName: r.contactName,
    }));
  } catch {
    return [];
  }
}

export default async function CalendarPage() {
  const u = await getPrimaryUser();
  const events = u ? await getEvents(u.id) : [];

  return (
    <div className="mx-auto max-w-[1500px]">
      <div className="mb-1">
        <h1 className="text-[28px] font-bold tracking-tight">Calendar</h1>
        <p className="mt-1 text-sm text-muted">
          Your week. Meetings with people in your network are highlighted — click one after it starts to
          confirm whether it held and jot notes that save to their profile.
        </p>
      </div>
      {!u ? (
        <p className="mt-8 text-sm text-muted">Connect the database to see your calendar.</p>
      ) : (
        <CalendarWeek events={events} />
      )}
    </div>
  );
}
