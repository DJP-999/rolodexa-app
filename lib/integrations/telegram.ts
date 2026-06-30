import { env, isConfigured } from "@/lib/env";

/**
 * Telegram adapter — primary delivery + tappable approvals.
 * Messages split into "bubbles" on a line containing only '---'.
 */
export type ApprovalButton = { label: string; data: string };

/** Escape text for Telegram HTML parse mode (only &, <, > are special). */
export function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render a contact's name as an HTML link to their LinkedIn (so the user can one-tap the name in
 * a nudge to vet them before reaching out). Falls back to bold plain text when no URL is known.
 * Use ONLY with `{ html: true }`.
 */
export function contactLink(name: string, linkedinUrl?: string | null): string {
  const n = htmlEscape(name || "Contact");
  return linkedinUrl && /^https?:\/\//i.test(linkedinUrl)
    ? `<a href="${htmlEscape(linkedinUrl)}">${n}</a>`
    : `<b>${n}</b>`;
}

export async function sendMessage(
  chatId: string,
  text: string,
  buttons?: ApprovalButton[],
  opts?: { plain?: boolean; html?: boolean },
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
        // Plain mode avoids "can't parse entities" failures on free-form draft text; HTML mode is
        // used for cards with linked contact names (escape dynamic text with htmlEscape first).
        ...(opts?.plain
          ? {}
          : opts?.html
            ? { parse_mode: "HTML", disable_web_page_preview: true }
            : { parse_mode: "Markdown" }),
        reply_markup: isLast ? keyboard : undefined,
      }),
    });
    ok = ok && res.ok;
    if (!res.ok) console.error(`[telegram] sendMessage → ${res.status}`);
  }
  return ok;
}

/** Replace a message's text and inline keyboard (pass no buttons to REMOVE the keyboard). */
export async function editMessage(
  chatId: string,
  messageId: number,
  text: string,
  buttons?: ApprovalButton[],
  opts?: { plain?: boolean },
): Promise<void> {
  if (!isConfigured("telegram")) return;
  const reply_markup = {
    inline_keyboard: buttons && buttons.length ? [buttons.map((b) => ({ text: b.label, callback_data: b.data }))] : [],
  };
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(opts?.plain ? {} : { parse_mode: "Markdown" }),
        reply_markup,
      }),
    });
    if (!res.ok) console.error(`[telegram] editMessage → ${res.status}`);
  } catch (e) {
    console.error("[telegram] editMessage", e);
  }
}

/** After a card action: strip the buttons and append a status line so it's clearly resolved. */
export async function finishCard(
  chatId: string,
  messageId: number | undefined,
  origText: string,
  status: string,
): Promise<void> {
  if (!messageId) return;
  await editMessage(chatId, messageId, `${origText}\n\n${status}`.trim(), undefined, { plain: true });
}

export async function answerCallback(callbackId: string, text?: string): Promise<void> {
  if (!isConfigured("telegram")) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text }),
  });
}
