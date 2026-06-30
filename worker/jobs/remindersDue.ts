import { and, eq, lte } from "drizzle-orm";
import { db } from "@/db";
import { connectedAccounts, contacts, reminders } from "@/db/schema";
import { sendMessage, contactLink, htmlEscape, type ApprovalButton } from "@/lib/integrations/telegram";

/**
 * Fire any follow-up reminders that have come due, as a Telegram nudge. The contact's name links
 * to their LinkedIn, and the card carries one-tap controls: Reach out (draft now), Done, or
 * Tomorrow (snooze a day). Marks each "sent" so it never double-fires.
 */
export async function runRemindersDue(): Promise<void> {
  const due = await db
    .select()
    .from(reminders)
    .where(and(eq(reminders.status, "pending"), lte(reminders.dueAt, new Date())));
  if (!due.length) return;

  const chatByUser = new Map<string, string | null>();
  const chatFor = async (userId: string): Promise<string | null> => {
    if (chatByUser.has(userId)) return chatByUser.get(userId) ?? null;
    const tg = (
      await db
        .select()
        .from(connectedAccounts)
        .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, "telegram")))
        .limit(1)
    )[0];
    const chat = tg?.externalId ?? null;
    chatByUser.set(userId, chat);
    return chat;
  };

  let sent = 0;
  for (const r of due) {
    const chat = await chatFor(r.userId);
    if (!chat) continue;

    const c = r.contactId
      ? (await db.select().from(contacts).where(eq(contacts.id, r.contactId)).limit(1))[0]
      : null;
    const nameLine = c
      ? contactLink(c.name, c.linkedinUrl)
      : r.contactName
        ? `<b>${htmlEscape(r.contactName)}</b>`
        : "";
    const meta = c ? [c.role, c.company].filter(Boolean).join(" · ") : "";
    const text =
      `⏰ Reminder: ${htmlEscape(r.note)}` + (nameLine ? `\n${nameLine}${meta ? ` — ${htmlEscape(meta)}` : ""}` : "");

    const buttons: ApprovalButton[] = [];
    if (c) buttons.push({ label: "✍️ Reach out", data: `reachC:${c.id}` });
    buttons.push({ label: "✅ Done", data: `rmdone:${r.id}` }, { label: "⏰ Tomorrow", data: `rmsnooze:${r.id}` });

    const ok = await sendMessage(chat, text, buttons, { html: true });
    if (ok) {
      await db.update(reminders).set({ status: "sent", sentAt: new Date() }).where(eq(reminders.id, r.id));
      sent++;
    }
  }
  console.log(`[reminders] fired ${sent}/${due.length} due reminder(s)`);
}
