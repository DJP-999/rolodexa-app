"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { calendarEvents, interactions } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";

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
