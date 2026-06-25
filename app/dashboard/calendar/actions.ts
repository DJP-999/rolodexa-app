"use server";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { calendarEvents, connectedAccounts, contacts, interactions, userContext } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { promoteColdProspect, selfEmails, normEmail } from "@/lib/sync/track";
import { isNoiseEmail } from "@/lib/sync/noise";
import { applyMeetingNotes } from "@/lib/notes/interpret";
import { enqueue } from "@/worker/scheduler";
import { complete } from "@/lib/llm";
import { sendEmail } from "@/lib/integrations/unipile";
import { stripEmDashes } from "@/lib/agent/tone";

const RESCHEDULE_SUBJECT = "Grabbing time next week?";

/** Resolve the meeting's guest (the non-self attendee) to an email + name + contact. */
async function resolveGuest(
  userId: string,
  ev: typeof calendarEvents.$inferSelect,
): Promise<{ to: string | null; name: string; contactId: string | null }> {
  let contactId = ev.matchedContactId;
  let to: string | null = null;
  let name = "";
  if (contactId) {
    const c = (await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1))[0];
    if (c) {
      to = c.email ?? null;
      name = c.name;
    }
  }
  if (!to) {
    const self = await selfEmails(userId);
    const att = (ev.attendees ?? []).find(
      (a) => a.email && !self.has(a.email.toLowerCase()) && !isNoiseEmail(a.email),
    );
    if (att) {
      to = normEmail(att.email);
      name = att.name || to;
    }
  }
  return { to, name: name || (to ? to.split("@")[0] : "there"), contactId };
}

/** Draft a nonchalant, peer-to-peer reschedule email for a no-show. */
export async function draftReschedule(
  id: string,
): Promise<{ ok: boolean; to?: string; name?: string; subject?: string; body?: string; error?: string }> {
  const u = await getPrimaryUser();
  if (!u) return { ok: false, error: "no user" };
  const ev = await ownEvent(u.id, id);
  if (!ev) return { ok: false, error: "not found" };
  const g = await resolveGuest(u.id, ev);
  if (!g.to) return { ok: false, error: "No email on file for this guest." };
  const first = g.name.split(/\s+/)[0] || "there";
  const ws = (await db.select({ w: userContext.writingStyle }).from(userContext).where(eq(userContext.userId, u.id)).limit(1))[0]?.w;

  const out = await complete({
    tier: "strong",
    system:
      "Write a SHORT, casual, peer-to-peer email proposing to reschedule a meeting that didn't happen. " +
      "Warm and nonchalant — never apologetic, never groveling, no corporate filler, no over-explaining. " +
      "2-3 sentences. Acknowledge lightly that you missed each other, propose finding time next week, and ask what works. " +
      (ws ? `Match this person's writing voice: ${ws}. ` : "") +
      "Return ONLY the email body — no subject line, no signature.",
    messages: [{ role: "user", content: `Recipient first name: ${first}. Meeting was: ${ev.title ?? "our chat"}. Write it.` }],
    maxTokens: 220,
    temperature: 0.6,
  });
  const fallback = `Hey ${first} — looks like we missed each other, no worries at all. Want to grab time next week instead? I'm pretty open, just let me know what works on your end.`;
  const body = stripEmDashes((out && !out.startsWith("[llm-stub") ? out : fallback).trim());
  return { ok: true, to: g.to, name: g.name, subject: RESCHEDULE_SUBJECT, body };
}

/** Send the (possibly edited) reschedule email to the guest and log it. */
export async function sendReschedule(id: string, body: string): Promise<{ ok: boolean; error?: string }> {
  const u = await getPrimaryUser();
  if (!u) return { ok: false, error: "no user" };
  const ev = await ownEvent(u.id, id);
  if (!ev) return { ok: false, error: "not found" };
  const g = await resolveGuest(u.id, ev);
  if (!g.to) return { ok: false, error: "no guest email" };
  const text = stripEmDashes((body ?? "").trim());
  if (!text) return { ok: false, error: "empty message" };
  const acct = (
    await db
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, u.id), eq(connectedAccounts.provider, "email")))
      .limit(1)
  )[0];
  if (!acct?.externalId) return { ok: false, error: "no email account connected" };
  const ok = await sendEmail(acct.externalId, { to: g.to, subject: RESCHEDULE_SUBJECT, body: text });
  if (!ok) return { ok: false, error: "send failed" };
  await db
    .insert(interactions)
    .values({
      userId: u.id,
      contactId: g.contactId,
      eventType: "email_out",
      direction: "outbound",
      channel: "nylas_email",
      occurredAt: new Date(),
      sourceRef: `reschedule-${id}-${Date.now()}`,
      counterpartyEmail: g.to,
      counterpartyName: g.name,
      metadata: { subject: RESCHEDULE_SUBJECT, text: text.slice(0, 200) },
    })
    .onConflictDoNothing();
  return { ok: true };
}

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
