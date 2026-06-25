"use server";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { calendarEvents, contacts, interactions } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { promoteColdProspect, selfEmails, normEmail } from "@/lib/sync/track";
import { isNoiseEmail } from "@/lib/sync/noise";
import { applyMeetingNotes } from "@/lib/notes/interpret";
import { enqueue } from "@/worker/scheduler";

/** Create (or find) a contact from a held meeting that isn't linked to anyone yet. */
async function contactFromEvent(
  userId: string,
  ev: typeof calendarEvents.$inferSelect,
): Promise<string | null> {
  const self = await selfEmails(userId);
  const att = (ev.attendees ?? []).find(
    (a) => a.email && !self.has(a.email.toLowerCase()) && !isNoiseEmail(a.email),
  );
  const email = att ? normEmail(att.email) : "";
  if (email) {
    const existing = (
      await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.userId, userId), sql`lower(${contacts.email}) = ${email}`))
        .limit(1)
    )[0];
    if (existing) return existing.id;
  }
  // Need a name: attendee name → attendee email → event title. Bail if we have nothing real.
  const name = att?.name || (email ? email.split("@")[0] : "") || (ev.title ?? "").trim();
  if (!name) return null;
  const row = (
    await db
      .insert(contacts)
      .values({
        userId,
        name,
        email: email || null,
        relationship: "other",
        lastContactedAt: ev.startAt,
      })
      .returning({ id: contacts.id })
  )[0];
  return row?.id ?? null;
}

async function ownEvent(userId: string, id: string) {
  return (
    await db
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, id), eq(calendarEvents.userId, userId)))
      .limit(1)
  )[0];
}

/** Confirm whether a meeting actually happened. Drives the 'Meetings held' KPI. */
export async function setMeetingOutcome(id: string, held: boolean): Promise<{ ok: boolean }> {
  const u = await getPrimaryUser();
  if (!u || !id) return { ok: false };
  const ev = await ownEvent(u.id, id);
  if (!ev) return { ok: false };
  await db
    .update(calendarEvents)
    .set({ held, heldConfirmedAt: new Date(), updatedAt: new Date() })
    .where(eq(calendarEvents.id, id));

  // Confirming you met with someone graduates them into the rolodex: promote a linked cold
  // prospect, or create a contact straight from the meeting's attendee/title.
  let contactId = ev.matchedContactId;
  if (held && !contactId) {
    contactId = ev.coldProspectId ? await promoteColdProspect(ev.coldProspectId) : await contactFromEvent(u.id, ev);
    if (contactId) {
      await db.update(calendarEvents).set({ matchedContactId: contactId }).where(eq(calendarEvents.id, id));
      await db
        .insert(interactions)
        .values({
          userId: u.id,
          contactId,
          eventType: "meeting",
          direction: "outbound",
          channel: "nylas_calendar",
          occurredAt: ev.startAt,
          sourceRef: `cal-${ev.sourceRef}`,
          metadata: { subject: ev.title, notes: ev.notes ?? null },
        })
        .onConflictDoNothing();
    }
  }

  // Dexa reads the meeting notes and files them into the contact's fields, then re-grades.
  if (held && contactId && ev.notes && ev.notes.trim()) {
    await applyMeetingNotes(contactId, ev.notes);
    await enqueue("fit-grade");
  }
  return { ok: true };
}

/** Save meeting notes (typed live during/after the meeting). Mirrored to the contact timeline. */
export async function saveMeetingNotes(id: string, notes: string): Promise<{ ok: boolean }> {
  const u = await getPrimaryUser();
  if (!u || !id) return { ok: false };
  const ev = await ownEvent(u.id, id);
  if (!ev) return { ok: false };
  const trimmed = notes.slice(0, 8000);
  await db.update(calendarEvents).set({ notes: trimmed, updatedAt: new Date() }).where(eq(calendarEvents.id, id));
  // Mirror onto the linked contact's timeline so notes live under their profile too.
  if (ev.matchedContactId) {
    await db
      .update(interactions)
      .set({ metadata: { subject: ev.title, notes: trimmed } })
      .where(and(eq(interactions.userId, u.id), eq(interactions.sourceRef, `cal-${ev.sourceRef}`)));
  }
  return { ok: true };
}
