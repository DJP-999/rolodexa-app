import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { suggestions, notificationEvents, messageLog } from "@/db/schema";
import { env } from "@/lib/env";
import { answerCallback } from "@/lib/integrations/telegram";

export const dynamic = "force-dynamic";

/**
 * Telegram webhook. Captures tappable approvals → suggestion status + the
 * outcome that feeds the nightly learning loop. Also logs inbound chat.
 * Approval callback_data format: "<action>:<suggestionId>" (approve|snooze|dismiss).
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
          .set({ status: outcome === "approved" ? "approved" : outcome === "snoozed" ? "snoozed" : "dismissed", updatedAt: new Date() })
          .where(eq(suggestions.id, suggestionId));
        await db
          .update(notificationEvents)
          .set({ outcome, outcomeAt: new Date() })
          .where(eq(notificationEvents.suggestionId, suggestionId));
      }
      await answerCallback(cb.id, "Got it.");
    } else if (body.message) {
      const chatId = body.message.chat?.id;
      const text = body.message.text ?? "";
      // Best-effort inbound log; user resolution by chat id arrives in Phase 1.
      if (chatId) {
        await db.insert(messageLog).values({
          userId: chatId.toString().length ? chatId.toString() : "00000000-0000-0000-0000-000000000000",
          direction: "inbound",
          channel: "telegram",
          text,
        }).catch(() => undefined);
      }
    }
  } catch (err) {
    console.error("[telegram/webhook]", err);
  }

  return NextResponse.json({ ok: true });
}
