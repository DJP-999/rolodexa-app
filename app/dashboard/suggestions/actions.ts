"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { suggestions, connectedAccounts, interactions, notificationEvents } from "@/db/schema";
import { sendMessage } from "@/lib/integrations/telegram";
import { runOnce } from "@/worker/scheduler";

async function getSuggestion(id: string) {
  return (await db.select().from(suggestions).where(eq(suggestions.id, id)).limit(1))[0];
}

async function telegramChat(userId: string): Promise<string | null> {
  const tg = (
    await db
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, "telegram")))
      .limit(1)
  )[0];
  return tg?.externalId ?? null;
}

/** Approve → send the draft to Telegram (if linked), log the touchpoint + outcome. */
export async function approveAction(formData: FormData) {
  const id = String(formData.get("id"));
  const s = await getSuggestion(id);
  if (!s) return;

  let sent = false;
  const chat = await telegramChat(s.userId);
  if (chat && s.draftMessage) sent = await sendMessage(chat, s.draftMessage);

  if (sent && s.contactId) {
    await db
      .insert(interactions)
      .values({
        userId: s.userId,
        contactId: s.contactId,
        eventType: "message_out",
        direction: "outbound",
        channel: "telegram",
        occurredAt: new Date(),
        sourceRef: `approve-${id}`,
      })
      .onConflictDoNothing();
  }

  await db
    .insert(notificationEvents)
    .values({
      userId: s.userId,
      suggestionId: id,
      contactId: s.contactId ?? null,
      triggerType: s.triggerType,
      category: s.triggerType,
      channel: "telegram",
      sentAt: new Date(),
      outcome: "approved",
    });

  await db
    .update(suggestions)
    .set({ status: sent ? "sent" : "approved", updatedAt: new Date() })
    .where(eq(suggestions.id, id));
  revalidatePath("/dashboard/suggestions");
}

export async function snoozeAction(formData: FormData) {
  const id = String(formData.get("id"));
  await db
    .update(suggestions)
    .set({ status: "snoozed", updatedAt: new Date() })
    .where(eq(suggestions.id, id));
  const s = await getSuggestion(id);
  if (s)
    await db.insert(notificationEvents).values({
      userId: s.userId,
      suggestionId: id,
      contactId: s.contactId ?? null,
      triggerType: s.triggerType,
      category: s.triggerType,
      sentAt: new Date(),
      outcome: "snoozed",
    });
  revalidatePath("/dashboard/suggestions");
}

export async function dismissAction(formData: FormData) {
  const id = String(formData.get("id"));
  await db
    .update(suggestions)
    .set({ status: "dismissed", updatedAt: new Date() })
    .where(eq(suggestions.id, id));
  const s = await getSuggestion(id);
  if (s)
    await db.insert(notificationEvents).values({
      userId: s.userId,
      suggestionId: id,
      contactId: s.contactId ?? null,
      triggerType: s.triggerType,
      category: s.triggerType,
      sentAt: new Date(),
      outcome: "dismissed",
    });
  revalidatePath("/dashboard/suggestions");
}

/** Save a hand-edited draft message. Keeps the user's exact wording (no transforms). */
export async function saveDraftAction(formData: FormData) {
  const id = String(formData.get("id"));
  const message = String(formData.get("message") ?? "").trim();
  if (!id) return;
  await db
    .update(suggestions)
    .set({ draftMessage: message, updatedAt: new Date() })
    .where(eq(suggestions.id, id));
  revalidatePath("/dashboard/suggestions");
}

/** Generate → run the suggestions job on demand. */
export async function generateAction() {
  await runOnce("suggestions");
  revalidatePath("/dashboard/suggestions");
}
