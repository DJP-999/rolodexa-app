import { eq } from "drizzle-orm";
import { db } from "@/db";
import { connectedAccounts } from "@/db/schema";
import { getChatAttendees, getChatMessages, getChats, unipileConfigured } from "@/lib/integrations/unipile";
import { logTouch } from "@/lib/sync/track";

const LOOKBACK_MS = 3 * 60 * 60 * 1000;

/**
 * Frequent LinkedIn poll. Pulls recent chats and logs messages (both directions),
 * attributing each to a contact (by member id / name) or, when unknown, to a cold
 * prospect. Complements the nightly enrichment sync with near-real-time coverage.
 */
export async function runLinkedinPoll(): Promise<void> {
  if (!unipileConfigured()) {
    console.log("[linkedinPoll] unipile not configured — skip");
    return;
  }
  const cutoff = Date.now() - LOOKBACK_MS;
  const cutoffIso = new Date(cutoff).toISOString();
  const accts = await db.select().from(connectedAccounts).where(eq(connectedAccounts.provider, "linkedin"));
  let n = 0;

  for (const g of accts) {
    if (!g.externalId) continue;
    const chats = await getChats(g.externalId, cutoffIso);
    for (const chat of chats) {
      if (!chat?.id) continue;
      const chatId = String(chat.id);

      // Resolve the other party's member id + name (1:1 chats expose it directly).
      let memberId = chat.attendee_provider_id ? String(chat.attendee_provider_id) : null;
      let name: string | null = null;
      if (!memberId || !name) {
        for (const a of await getChatAttendees(chatId)) {
          if (a?.is_self) continue;
          memberId = memberId || (a?.provider_id ? String(a.provider_id) : null);
          name = name || (typeof a?.name === "string" ? a.name : typeof a?.display_name === "string" ? a.display_name : null);
          if (memberId && name) break;
        }
      }

      const msgs = await getChatMessages(chatId);
      for (const m of msgs.slice(0, 30)) {
        if (!m?.id || !m?.timestamp) continue;
        const when = new Date(m.timestamp);
        if (isNaN(when.getTime()) || when.getTime() < cutoff) continue;
        const outbound = !!m.is_sender;
        await logTouch({
          userId: g.userId,
          channel: "linkedin",
          direction: outbound ? "outbound" : "inbound",
          eventType: outbound ? "message_out" : "message_in",
          occurredAt: when,
          sourceRef: String(m.id),
          threadId: chatId,
          counterpartyMemberId: memberId,
          counterpartyName: name,
          text: typeof m.text === "string" ? m.text : null,
        });
        n++;
      }
    }
  }
  console.log(`[linkedinPoll] processed ${n} message(s) across ${accts.length} account(s)`);
}
