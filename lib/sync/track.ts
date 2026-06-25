import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { calendarEvents, coldProspects, connectedAccounts, contacts, interactions, users } from "@/db/schema";
import { getBlacklist, isNoiseEmail } from "@/lib/sync/noise";
import { listAccounts } from "@/lib/integrations/unipile";

/** Pull a mailbox address off a Unipile account object, defensively. */
function accountEmail(a: any): string | null {
  const cands = [a?.name, a?.connection_params?.mail?.username, a?.connection_params?.mail?.email, a?.email];
  for (const c of cands) if (typeof c === "string" && c.includes("@")) return c.toLowerCase().trim();
  return null;
}

const selfCache = new Map<string, { set: Set<string>; ts: number }>();

/** The user's own address(es): login email + every connected mailbox/calendar address
 *  (including the Unipile mailbox, resolved from the account). Used to tell inbound from
 *  outbound and to NEVER treat the user as the counterparty/contact on their own meetings.
 *  Cached briefly so polls don't re-hit Unipile on every touch. */
export async function selfEmails(userId: string): Promise<Set<string>> {
  const cached = selfCache.get(userId);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.set;
  const set = new Set<string>();
  try {
    const u = (await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1))[0];
    if (u?.email) set.add(normEmail(u.email));
    const accts = await db
      .select({ provider: connectedAccounts.provider, externalId: connectedAccounts.externalId, metadata: connectedAccounts.metadata })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.userId, userId));
    for (const a of accts) {
      const m = (a.metadata ?? {}) as { email?: string };
      if (m.email) set.add(normEmail(m.email));
    }
    // Resolve the connected Unipile mailbox's own address (its metadata lacks the email).
    const emailIds = new Set(accts.filter((a) => a.provider === "email" && a.externalId).map((a) => String(a.externalId)));
    if (emailIds.size) {
      for (const acct of await listAccounts()) {
        if (!acct?.id || !emailIds.has(String(acct.id))) continue;
        const em = accountEmail(acct);
        if (em) set.add(em);
      }
    }
  } catch {
    /* ignore */
  }
  selfCache.set(userId, { set, ts: Date.now() });
  return set;
}

export function normEmail(e?: string | null): string {
  return (e ?? "").toLowerCase().trim();
}

/** Find an existing contact by email (preferred) or LinkedIn member id. */
export async function findContact(
  userId: string,
  opts: { email?: string | null; memberId?: string | null },
): Promise<string | null> {
  const email = normEmail(opts.email);
  if (email) {
    const c = (
      await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.userId, userId), sql`lower(${contacts.email}) = ${email}`))
        .limit(1)
    )[0];
    if (c) return c.id;
  }
  if (opts.memberId) {
    const c = (
      await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.userId, userId), eq(contacts.linkedinMemberId, opts.memberId)))
        .limit(1)
    )[0];
    if (c) return c.id;
  }
  return null;
}

type Channel = "nylas_email" | "linkedin" | "telegram" | "imessage" | "agent_audit" | "nylas_calendar";

export type TouchInput = {
  userId: string;
  channel: Channel;
  direction: "inbound" | "outbound";
  eventType: "email_in" | "email_out" | "message_in" | "message_out" | "meeting";
  occurredAt: Date;
  sourceRef: string;
  threadId?: string | null;
  contactId?: string | null;
  counterpartyEmail?: string | null;
  counterpartyName?: string | null;
  counterpartyMemberId?: string | null;
  text?: string | null;
  subject?: string | null;
};

/** Was this inbound message a reply to something the user sent on the same thread/counterparty? */
async function detectReply(t: TouchInput): Promise<boolean> {
  if (t.direction !== "inbound") return false;
  try {
    if (t.threadId) {
      const prior = (
        await db
          .select({ id: interactions.id })
          .from(interactions)
          .where(
            and(
              eq(interactions.userId, t.userId),
              eq(interactions.threadId, t.threadId),
              eq(interactions.direction, "outbound"),
            ),
          )
          .limit(1)
      )[0];
      if (prior) return true;
    }
    const cpe = normEmail(t.counterpartyEmail);
    if (cpe) {
      const prior = (
        await db
          .select({ id: interactions.id })
          .from(interactions)
          .where(
            and(
              eq(interactions.userId, t.userId),
              eq(interactions.direction, "outbound"),
              sql`lower(${interactions.counterpartyEmail}) = ${cpe}`,
            ),
          )
          .limit(1)
      )[0];
      if (prior) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Log a touchpoint idempotently. Resolves a contact (if any), tracks the cold prospect
 * when there's no contact, flags replies, and keeps the cold-prospect lifecycle current.
 * Returns the contactId / coldProspectId it attributed to.
 */
export async function logTouch(t: TouchInput): Promise<{ contactId: string | null; coldProspectId: string | null }> {
  // Drop automated / marketing / blacklisted senders — they were never a real conversation.
  const cpe = normEmail(t.counterpartyEmail);
  if (cpe && !t.contactId && (isNoiseEmail(cpe) || (await getBlacklist(t.userId)).has(cpe))) {
    return { contactId: null, coldProspectId: null };
  }
  let contactId = t.contactId ?? null;
  if (!contactId) {
    contactId = await findContact(t.userId, { email: t.counterpartyEmail, memberId: t.counterpartyMemberId });
  }

  // No contact match → this is cold outreach / unknown counterparty. Track the prospect.
  let coldId: string | null = null;
  if (!contactId && (normEmail(t.counterpartyEmail) || t.counterpartyMemberId)) {
    coldId = await upsertColdProspect(t);
  }

  const isReply = await detectReply(t);

  await db
    .insert(interactions)
    .values({
      userId: t.userId,
      contactId,
      eventType: t.eventType,
      direction: t.direction,
      channel: t.channel,
      threadId: t.threadId ?? null,
      occurredAt: t.occurredAt,
      sourceRef: t.sourceRef,
      isReply,
      counterpartyEmail: normEmail(t.counterpartyEmail) || null,
      counterpartyName: t.counterpartyName ?? null,
      coldProspectId: coldId,
      metadata: { subject: t.subject ?? null, text: t.text ? t.text.slice(0, 1200) : null },
    })
    .onConflictDoNothing();

  return { contactId, coldProspectId: coldId };
}

/** Insert/update a cold prospect from a touch, advancing its lifecycle. Returns its id. */
export async function upsertColdProspect(t: TouchInput): Promise<string | null> {
  const email = normEmail(t.counterpartyEmail);
  const key = email || (t.counterpartyMemberId ? `li:${t.counterpartyMemberId}` : "");
  if (!key) return null;
  const inbound = t.direction === "inbound";
  const meeting = t.eventType === "meeting";

  try {
    const existing = (
      await db
        .select()
        .from(coldProspects)
        .where(and(eq(coldProspects.userId, t.userId), eq(coldProspects.identityKey, key)))
        .limit(1)
    )[0];

    if (!existing) {
      const row = (
        await db
          .insert(coldProspects)
          .values({
            userId: t.userId,
            name: t.counterpartyName ?? null,
            email: email || null,
            linkedinMemberId: t.counterpartyMemberId ?? null,
            identityKey: key,
            channel: t.channel === "linkedin" ? "linkedin" : "nylas_email",
            status: meeting ? "meeting_set" : inbound ? "replied" : "messaged",
            firstOutreachAt: inbound ? null : t.occurredAt,
            lastOutboundAt: inbound ? null : t.occurredAt,
            lastInboundAt: inbound ? t.occurredAt : null,
            meetingAt: meeting ? t.occurredAt : null,
            outboundCount: inbound ? 0 : 1,
            inboundCount: inbound ? 1 : 0,
          })
          .onConflictDoNothing()
          .returning({ id: coldProspects.id })
      )[0];
      return row?.id ?? null;
    }

    // Advance lifecycle (never downgrade a promoted/meeting_set prospect).
    const patch: Record<string, unknown> = { updatedAt: new Date(), name: existing.name ?? t.counterpartyName ?? null };
    if (email && !existing.email) patch.email = email;
    if (t.counterpartyName && !existing.name) patch.name = t.counterpartyName;
    if (inbound) {
      patch.lastInboundAt = t.occurredAt;
      patch.inboundCount = (existing.inboundCount ?? 0) + 1;
      if (existing.status === "messaged" || existing.status === "ghosted") patch.status = "replied";
    } else if (!meeting) {
      patch.lastOutboundAt = t.occurredAt;
      patch.outboundCount = (existing.outboundCount ?? 0) + 1;
      if (!existing.firstOutreachAt) patch.firstOutreachAt = t.occurredAt;
    }
    if (meeting && existing.status !== "promoted") {
      patch.status = "meeting_set";
      patch.meetingAt = t.occurredAt;
    }
    await db.update(coldProspects).set(patch).where(eq(coldProspects.id, existing.id));
    return existing.id;
  } catch (e) {
    console.error("[track] upsertColdProspect", e);
    return null;
  }
}

/** Existing cold prospect (by email), full row — to react to a calendar meeting. */
async function findColdProspect(userId: string, email: string) {
  const e = normEmail(email);
  if (!e) return null;
  try {
    return (
      (
        await db
          .select()
          .from(coldProspects)
          .where(and(eq(coldProspects.userId, userId), sql`lower(${coldProspects.email}) = ${e}`))
          .limit(1)
      )[0] ?? null
    );
  } catch {
    return null;
  }
}

/** Create a cold-pipeline profile for a meeting attendee who isn't in the rolodex yet. */
async function createColdFromMeeting(
  userId: string,
  email: string,
  name: string | null,
  when: Date,
): Promise<string | null> {
  const key = normEmail(email);
  if (!key || isNoiseEmail(key)) return null;
  try {
    const row = (
      await db
        .insert(coldProspects)
        .values({
          userId,
          name: name ?? null,
          email: key,
          identityKey: key,
          channel: "nylas_calendar",
          status: "meeting_set",
          meetingAt: when,
        })
        .onConflictDoNothing()
        .returning({ id: coldProspects.id })
    )[0];
    if (row) return row.id;
    const existing = await findColdProspect(userId, key);
    return existing?.id ?? null;
  } catch (e) {
    console.error("[track] createColdFromMeeting", e);
    return null;
  }
}

export type CalEventInput = {
  userId: string;
  sourceRef: string;
  source?: "calendar" | "llm";
  title: string | null;
  location?: string | null;
  startAt: Date;
  endAt?: Date | null;
  allDay?: boolean;
  attendees: { email: string; name: string | null }[];
  self: Set<string>;
  contactId?: string | null; // explicit fallback when attendees carry no matchable email
};

/**
 * Upsert a calendar event (full mirror). Links it to a contact, or to a prospect you'd
 * already cold-outreached (promoting them, since a meeting is now set). Brand-new external
 * invitees are NOT turned into contacts — the event simply shows on the calendar unlinked.
 * Never overwrites a human-entered held/notes outcome.
 */
export async function upsertCalendarEvent(ev: CalEventInput): Promise<void> {
  const ext = ev.attendees.filter((a) => a.email && !ev.self.has(a.email));
  const primary = ext[0] ?? null;
  let matchedContactId: string | null = null;
  let coldId: string | null = null;

  if (primary?.email) {
    matchedContactId = await findContact(ev.userId, { email: primary.email });
    if (!matchedContactId) {
      const cp = await findColdProspect(ev.userId, primary.email);
      if (cp) {
        coldId = cp.id;
        // A booked meeting marks them meeting_set but never promotes — promotion happens
        // only once you confirm you actually met (held = yes) or promote manually.
        if (cp.status !== "promoted") {
          await db
            .update(coldProspects)
            .set({ status: "meeting_set", meetingAt: ev.startAt, updatedAt: new Date() })
            .where(eq(coldProspects.id, cp.id));
        } else if (cp.promotedContactId) {
          matchedContactId = cp.promotedContactId; // already a contact → link the event
        }
      } else {
        coldId = await createColdFromMeeting(ev.userId, primary.email, primary.name, ev.startAt);
      }
    }
  }
  if (!matchedContactId && ev.contactId) matchedContactId = ev.contactId;

  try {
    await db
      .insert(calendarEvents)
      .values({
        userId: ev.userId,
        sourceRef: ev.sourceRef,
        source: ev.source ?? "calendar",
        title: ev.title,
        location: ev.location ?? null,
        startAt: ev.startAt,
        endAt: ev.endAt ?? null,
        allDay: ev.allDay ?? false,
        attendees: ev.attendees,
        matchedContactId,
        coldProspectId: coldId,
      })
      .onConflictDoUpdate({
        target: [calendarEvents.userId, calendarEvents.sourceRef],
        set: {
          title: ev.title,
          location: ev.location ?? null,
          startAt: ev.startAt,
          endAt: ev.endAt ?? null,
          allDay: ev.allDay ?? false,
          attendees: ev.attendees,
          matchedContactId,
          coldProspectId: coldId,
          updatedAt: new Date(),
        },
      });
  } catch (e) {
    console.error("[track] upsertCalendarEvent", e);
  }

  // Mirror a meeting touch onto the contact timeline so "last meeting" stays accurate.
  // Delete-then-insert so a re-sync re-points events that were previously mis-matched
  // (e.g. to yourself) to the correct contact — or to nobody.
  await db
    .delete(interactions)
    .where(and(eq(interactions.userId, ev.userId), eq(interactions.sourceRef, `cal-${ev.sourceRef}`)));
  if (matchedContactId) {
    await db
      .insert(interactions)
      .values({
        userId: ev.userId,
        contactId: matchedContactId,
        eventType: "meeting",
        direction: "outbound",
        channel: "nylas_calendar",
        occurredAt: ev.startAt,
        sourceRef: `cal-${ev.sourceRef}`,
        counterpartyEmail: primary?.email ?? null,
        counterpartyName: primary?.name ?? null,
        metadata: { subject: ev.title },
      })
      .onConflictDoNothing();
  }
}

/** Promote a cold prospect into the real rolodex (called when a meeting is set). */
export async function promoteColdProspect(id: string): Promise<string | null> {
  try {
    const p = (await db.select().from(coldProspects).where(eq(coldProspects.id, id)).limit(1))[0];
    if (!p) return null;
    if (p.promotedContactId) return p.promotedContactId;
    const newId = (
      await db
        .insert(contacts)
        .values({
          userId: p.userId,
          name: p.name || p.email || "Unknown",
          email: p.email ?? null,
          company: p.company ?? null,
          linkedinMemberId: p.linkedinMemberId ?? null,
          relationship: "other",
          source: "meeting",
          lastContactedAt: p.lastInboundAt ?? p.lastOutboundAt ?? new Date(),
        })
        .returning({ id: contacts.id })
    )[0];
    if (!newId) return null;
    await db
      .update(coldProspects)
      .set({ status: "promoted", promotedContactId: newId.id, updatedAt: new Date() })
      .where(eq(coldProspects.id, id));
    // Re-point this prospect's interactions to the new contact so history follows them.
    await db
      .update(interactions)
      .set({ contactId: newId.id })
      .where(and(eq(interactions.userId, p.userId), eq(interactions.coldProspectId, id)));
    return newId.id;
  } catch (e) {
    console.error("[track] promoteColdProspect", e);
    return null;
  }
}
