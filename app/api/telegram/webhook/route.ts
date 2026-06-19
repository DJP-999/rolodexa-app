import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { users, suggestions, notificationEvents, connectedAccounts, messageLog } from "@/db/schema";
import { env } from "@/lib/env";
import { answerCallback, sendMessage } from "@/lib/integrations/telegram";

export const dynamic = "force-dynamic";

/**
 * Telegram webhook.
 *  - On a message: link the sender's chat to the (single) user by upserting
 *    connected_accounts(provider='telegram'), so briefs + approved suggestions
 *    deliver here. Replies with a confirmation.
 *  - On a tappable approval (callback_data "<action>:<suggestionId>"): update the
 *    suggestion + log the outcome to the feedback loop.
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
      const [action, suggestionId] = String(cb.data).split(":");
      const map: Record<string, "approved" | "snoozed" | "dismissed"> = {
        approve: "approved",
        snooze: "snoozed",
        dismiss: "dismissed",
      };
      const outcome = map[action];
      if (outcome && suggestionId) {
        await db
          .update(suggestions)
          .set({ status: outcome === "approved" ? "sent" : outcome, updatedAt: new Date() })
          .where(eq(suggestions.id, suggestionId));
        await db
          .update(notificationEvents)
          .set({ outcome, outcomeAt: new Date() })
          .where(eq(notificationEvents.suggestionId, suggestionId));
      }
      await answerCallback(cb.id, "Got it ✓");
      return NextResponse.json({ ok: true });
    }

    const message = body.message;
    if (message?.chat?.id) {
      const chatId = String(message.chat.id);
      const user = (await db.select().from(users).limit(1))[0];
      if (user) {
        const existing = (
          await db
            .select()
            .from(connectedAccounts)
            .where(
              and(
                eq(connectedAccounts.userId, user.id),
                eq(connectedAccounts.provider, "telegram"),
              ),
            )
            .limit(1)
        )[0];
        if (!existing) {
          await db.insert(connectedAccounts).values({
            userId: user.id,
            provider: "telegram",
            externalId: chatId,
            metadata: { username: message.from?.username ?? null },
          });
          await sendMessage(
            chatId,
            "✅ Connected to Rolodexa. Your morning, midday and night briefs — and any outreach you approve — will arrive here.",
          );
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
