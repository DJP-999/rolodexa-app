import { env, isConfigured } from "@/lib/env";

/**
 * Telegram adapter — primary delivery + tappable approvals.
 * Messages split into "bubbles" on a line containing only '---'.
 */
export type ApprovalButton = { label: string; data: string };

export async function sendMessage(
  chatId: string,
  text: string,
  buttons?: ApprovalButton[],
): Promise<boolean> {
  if (!isConfigured("telegram")) {
    console.warn(`[telegram] not configured — would send to ${chatId}:\n${text}`);
    return false;
  }
  const bubbles = text.split(/^\s*---\s*$/m).map((b) => b.trim()).filter(Boolean);
  const keyboard = buttons
    ? { inline_keyboard: [buttons.map((b) => ({ text: b.label, callback_data: b.data }))] }
    : undefined;

  let ok = true;
  for (let i = 0; i < bubbles.length; i++) {
    const isLast = i === bubbles.length - 1;
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: bubbles[i],
        parse_mode: "Markdown",
        reply_markup: isLast ? keyboard : undefined,
      }),
    });
    ok = ok && res.ok;
    if (!res.ok) console.error(`[telegram] sendMessage → ${res.status}`);
  }
  return ok;
}

export async function answerCallback(callbackId: string, text?: string): Promise<void> {
  if (!isConfigured("telegram")) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text }),
  });
}
