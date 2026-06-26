import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { connectedAccounts, contacts, interactions, users } from "@/db/schema";
import { sendEmail, sendLinkedInMessage } from "@/lib/integrations/unipile";
import { stripEmDashes } from "@/lib/agent/tone";

type Contact = typeof contacts.$inferSelect;

export type DeliveryResult = { ok: boolean; channel: "linkedin" | "email" | null; detail: string };

async function unipileAccount(userId: string, provider: "linkedin" | "email"): Promise<string | null> {
  const a = (
    await db
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, provider)))
      .limit(1)
  )[0];
  return a?.externalId ?? null;
}

/**
 * Which channel to reach a contact on: the most recent channel you actually used
 * with them, else a LinkedIn DM when we have their member id, else email.
 */
export async function resolveChannel(contact: Contact): Promise<"linkedin" | "email" | null> {
  const last = (
    await db
      .select({ channel: interactions.channel })
      .from(interactions)
      .where(eq(interactions.contactId, contact.id))
      .orderBy(desc(interactions.occurredAt))
      .limit(1)
  )[0];
  if (last?.channel === "linkedin") return "linkedin";
  if (last?.channel === "nylas_email") return "email";
  if (contact.linkedinMemberId) return "linkedin";
  if (contact.email) return "email";
  return null;
}

async function logOutbound(
  userId: string,
  contactId: string,
  channel: "linkedin" | "nylas_email",
): Promise<void> {
  await db
    .insert(interactions)
    .values({
      userId,
      contactId,
      eventType: channel === "linkedin" ? "message_out" : "email_out",
      direction: "outbound",
      channel,
      occurredAt: new Date(),
      sourceRef: `dexa-approve-${contactId}-${Date.now()}`,
    })
    .onConflictDoNothing();
}

/**
 * Send approved outreach to a contact via their channel and log it as an outbound
 * touch. LinkedIn is tried first when chosen; if it can't go, we fall back to email.
 */
export async function deliverOutreach(
  userId: string,
  contact: Contact,
  rawText: string,
): Promise<DeliveryResult> {
  const text = stripEmDashes(rawText).trim();
  if (!text) return { ok: false, channel: null, detail: "empty message" };

  let channel = await resolveChannel(contact);

  if (channel === "linkedin") {
    const liId = await unipileAccount(userId, "linkedin");
    if (liId && contact.linkedinMemberId) {
      const ok = await sendLinkedInMessage(liId, { memberId: contact.linkedinMemberId, text });
      if (ok) {
        await logOutbound(userId, contact.id, "linkedin");
        return { ok: true, channel: "linkedin", detail: "LinkedIn" };
      }
    }
    channel = contact.email ? "email" : null; // fall back to email
  }

  if (channel === "email") {
    const emId = await unipileAccount(userId, "email");
    if (emId && contact.email) {
      const first = contact.name.split(/\s+/)[0] || "there";
      const sender = (
        await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId)).limit(1)
      )[0];
      const ok = await sendEmail(emId, {
        to: contact.email,
        subject: `Hi ${first}`,
        body: text,
        ...(sender?.email ? { from: { name: sender.name, email: sender.email } } : {}),
      });
      if (ok) {
        await logOutbound(userId, contact.id, "nylas_email");
        return { ok: true, channel: "email", detail: "email" };
      }
    }
  }

  return { ok: false, channel: null, detail: "no channel available" };
}
