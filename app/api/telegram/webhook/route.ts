import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  users,
  suggestions,
  contacts,
  notificationEvents,
  connectedAccounts,
  messageLog,
} from "@/db/schema";
import { env } from "@/lib/env";
import { answerCallback, finishCard, sendMessage } from "@/lib/integrations/telegram";
import { deliverOutreach, resolveChannel } from "@/lib/outreach/deliver";
import { SNOOZE_DAYS } from "@/lib/outreach/suppress";
import { APPROVE_BUTTONS, handleContactAction, handleDexaText, handleReminderAction } from "@/lib/agent/telegram";

export const dynamic = "force-dynamic";

const CONTACT_ACTIONS = ["reachC", "snoozeC", "dismissC", "blockC"];
const REMINDER_ACTIONS = ["rmdone", "rmsnooze"];

async function setPendingEdit(userId: string, suggestionId: string | null): Promise<void> {
  const row = (
    await db
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, "telegram")))
      .limit(1)
  )[0];
  if (!row) return;
  await db
    .update(connectedAccounts)
    .set({ metadata: { ...(row.metadata ?? {}), pendingEdit: suggestionId } })
    .where(eq(connectedAccounts.id, row.id));
}

/**
 * Telegram webhook.
 *  - Message: link the sender's chat to the user; OR, if they're mid-edit, treat the
 *    text as the revised draft and re-present it with Approve/Edit/Decline.
 *  - Callback (approve/edit/decline:<id>): approve SENDS the outreach via the contact's
 *    channel; edit asks for a revised draft; decline dismisses.
 */
export async function POST(req: Request) {
  if (
    env.TELEGRAM_WEBHOOK_SECRET &&
    req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  try {
    const cb = body.callback_query;
    if (cb?.data) {
      const chatId = String(cb.message?.chat?.id ?? cb.from?.id ?? "");
      const messageId: number | undefined = cb.message?.message_id;
      const origText: string = cb.message?.text ?? "";
      const [action, id] = String(cb.data).split(":");
      const primaryUser = (await db.select().from(users).limit(1))[0];

      // Contact-card actions (from chat replies / the digest) operate on a CONTACT id, and don't
      // require a pre-existing suggestion — handle them up front.
      if (primaryUser && CONTACT_ACTIONS.includes(action)) {
        await handleContactAction(primaryUser.id, action, id, chatId, cb.id, messageId, origText);
        return NextResponse.json({ ok: true });
      }

      // Reminder-card actions (✅ Done / ⏰ Tomorrow) operate on a reminder id.
      if (primaryUser && REMINDER_ACTIONS.includes(action)) {
        await handleReminderAction(primaryUser.id, action, id, chatId, cb.id, messageId, origText);
        return NextResponse.json({ ok: true });
      }

      const s = id
        ? (await db.select().from(suggestions).where(eq(suggestions.id, id)).limit(1))[0]
        : undefined;

      if (!s) {
        await answerCallback(cb.id, "That item is no longer available.");
        return NextResponse.json({ ok: true });
      }

      // --- Contact controls (handled BEFORE the sent/dismissed guard so Block still applies
      // even if the item was already dismissed). These set per-contact flags that suppress
      // future updates, per the user's rules. ---
      if (action === "snooze" || action === "dismiss" || action === "block") {
        if (s.contactId) {
          const patch =
            action === "snooze"
              ? { outreachSnoozedUntil: new Date(Date.now() + SNOOZE_DAYS * 86_400_000) }
              : action === "dismiss"
                ? { outreachDismissedAt: new Date() }
                : { outreachBlocked: true };
          await db.update(contacts).set(patch).where(eq(contacts.id, s.contactId));
        }
        await db
          .update(suggestions)
          .set({ status: action === "snooze" ? "snoozed" : "dismissed", updatedAt: new Date() })
          .where(eq(suggestions.id, s.id));
        await db
          .update(notificationEvents)
          .set({ outcome: action === "snooze" ? "snoozed" : "dismissed", outcomeAt: new Date() })
          .where(eq(notificationEvents.suggestionId, s.id));
        const note =
          action === "snooze"
            ? "Snoozed for 1 month 😴"
            : action === "dismiss"
              ? "Dismissed — won't resurface unless there's fresh news ✓"
              : "Blocked — no more updates on this person 🚫";
        await answerCallback(cb.id, note);
        await finishCard(chatId, messageId, origText, `${action === "snooze" ? "😴 Snoozed for 1 month" : action === "dismiss" ? "✕ Dismissed" : "🚫 Blocked"}`);
        return NextResponse.json({ ok: true });
      }

      if (s.status === "sent" || s.status === "dismissed") {
        await answerCallback(cb.id, `Already ${s.status}.`);
        await finishCard(chatId, messageId, origText, `(already ${s.status})`);
        return NextResponse.json({ ok: true });
      }

      // "Reach out" → reveal the drafted message and which channel it will go out on, with the
      // Approve / Edit / Cancel controls. The draft was prepared when the suggestion was created.
      if (action === "reach") {
        const contact = s.contactId
          ? (await db.select().from(contacts).where(eq(contacts.id, s.contactId)).limit(1))[0]
          : undefined;
        const channel = contact ? await resolveChannel(contact) : null;
        const via =
          channel === "linkedin"
            ? "Will send as a LinkedIn DM"
            : channel === "email"
              ? "Will send via email"
              : "No channel on file — open Rolodexa to send manually";
        await answerCallback(cb.id, "Here's the draft");
        await finishCard(chatId, messageId, origText, "✍️ Reach out — draft below");
        if (chatId)
          await sendMessage(
            chatId,
            `Draft to ${contact?.name ?? "contact"} — ${via}:\n\n${s.draftMessage ?? ""}`,
            APPROVE_BUTTONS(s.id),
            { plain: true },
          );
        return NextResponse.json({ ok: true });
      }

      if (action === "cancel") {
        await answerCallback(cb.id, "Cancelled — nothing sent.");
        await finishCard(chatId, messageId, origText, "✕ Cancelled");
        return NextResponse.json({ ok: true });
      }

      if (action === "approve") {
        const contact = s.contactId
          ? (await db.select().from(contacts).where(eq(contacts.id, s.contactId)).limit(1))[0]
          : undefined;
        const result = contact
          ? await deliverOutreach(s.userId, contact, s.draftMessage ?? "")
          : { ok: false, channel: null, detail: "no contact" };
        if (result.ok) {
          await db
            .update(suggestions)
            .set({ status: "sent", updatedAt: new Date() })
            .where(eq(suggestions.id, s.id));
          await db
            .update(notificationEvents)
            .set({ outcome: "approved", outcomeAt: new Date() })
            .where(eq(notificationEvents.suggestionId, s.id));
          await answerCallback(cb.id, `Sent via ${result.channel} ✓`);
          await finishCard(chatId, messageId, origText, `✅ Sent via ${result.channel}`);
        } else {
          await answerCallback(cb.id, "Couldn't auto-send — open it in the app.");
          await finishCard(chatId, messageId, origText, `⚠️ Couldn't auto-send (${result.detail}) — open Rolodexa to send.`);
        }
        return NextResponse.json({ ok: true });
      }

      if (action === "edit") {
        await setPendingEdit(s.userId, s.id);
        await answerCallback(cb.id, "Send me your edited version.");
        await finishCard(chatId, messageId, origText, "✏️ Editing — send me your version");
        if (chatId)
          await sendMessage(
            chatId,
            "✏️ Reply to this message with your edited version and I'll re-draft it for you to approve.",
            undefined,
            { plain: true },
          );
        return NextResponse.json({ ok: true });
      }

      if (action === "decline") {
        await db
          .update(suggestions)
          .set({ status: "dismissed", updatedAt: new Date() })
          .where(eq(suggestions.id, s.id));
        await db
          .update(notificationEvents)
          .set({ outcome: "dismissed", outcomeAt: new Date() })
          .where(eq(notificationEvents.suggestionId, s.id));
        await answerCallback(cb.id, "Declined ✓");
        await finishCard(chatId, messageId, origText, "✕ Declined");
        return NextResponse.json({ ok: true });
      }

      await answerCallback(cb.id, "Got it ✓");
      return NextResponse.json({ ok: true });
    }

    const message = body.message;
    if (message?.chat?.id) {
      const chatId = String(message.chat.id);
      const user = (await db.select().from(users).limit(1))[0];
      if (user) {
        const account = (
          await db
            .select()
            .from(connectedAccounts)
            .where(
              and(eq(connectedAccounts.userId, user.id), eq(connectedAccounts.provider, "telegram")),
            )
            .limit(1)
        )[0];

        if (!account) {
          await db.insert(connectedAccounts).values({
            userId: user.id,
            provider: "telegram",
            externalId: chatId,
            metadata: { username: message.from?.username ?? null },
          });
          await sendMessage(
            chatId,
            "✅ Connected. I'm Dexa, your relationship assistant. Just talk to me here, ask 'who should I reach out to today?', say 'draft a note to <name>', or 'snooze <name>'. Every update I send has one-tap actions too.",
            undefined,
            { plain: true },
          );
        } else {
          const pendingEdit = (account.metadata as { pendingEdit?: string } | null)?.pendingEdit;
          const newText = typeof message.text === "string" ? message.text.trim() : "";
          if (pendingEdit && newText) {
            // Mid-edit: treat this message as the revised draft and re-present it.
            const s = (
              await db.select().from(suggestions).where(eq(suggestions.id, pendingEdit)).limit(1)
            )[0];
            await setPendingEdit(user.id, null);
            if (s && s.status === "pending") {
              await db
                .update(suggestions)
                .set({ draftMessage: newText, updatedAt: new Date() })
                .where(eq(suggestions.id, s.id));
              await sendMessage(chatId, `Updated draft:\n\n${newText}`, APPROVE_BUTTONS(s.id), { plain: true });
            }
          } else if (newText) {
            // Otherwise it's a conversation with Dexa — answer or act on it.
            await handleDexaText(user.id, chatId, newText);
          }
        }

        await db
          .insert(messageLog)
          .values({
            userId: user.id,
            direction: "inbound",
            channel: "telegram",
            text: message.text ?? "",
          })
          .catch(() => undefined);
      }
    }
  } catch (err) {
    console.error("[telegram/webhook]", err);
  }

  return NextResponse.json({ ok: true });
}
