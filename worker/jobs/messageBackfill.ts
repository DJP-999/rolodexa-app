import { eq } from "drizzle-orm";
import { db } from "@/db";
import { connectedAccounts, contacts, interactions } from "@/db/schema";
import { getChatAttendees, getChatMessages, getChats, unipileConfigured } from "@/lib/integrations/unipile";
import { nameKey } from "@/lib/match/entity";

const PER_CHAT = 80; // deep history per conversation (the poll handles recency)

/**
 * Decoupled LinkedIn message backfill. Pulls chats for every connected LinkedIn account and
 * logs their messages as interactions — INDEPENDENT of the heavy nightly enrichment job, so
 * conversation history stays complete even when enrichment is interrupted by a deploy. Builds
 * the provider-id → contact map straight from stored linkedinMemberId (no relations refetch),
 * then resolves the rest by attendee id / name. Idempotent: duplicate messages are ignored.
 */
export async function runMessageBackfill(): Promise<void> {
  if (!unipileConfigured()) {
    console.log("[message-backfill] unipile not configured — skip");
    return;
  }
  const accts = await db
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.provider, "linkedin"));

  for (const g of accts) {
    if (!g.externalId) continue;

    const list = await db.select().from(contacts).where(eq(contacts.userId, g.userId));
    const providerToContact = new Map<string, string>();
    const nameMap = new Map<string, string>();
    for (const c of list) {
      if (c.linkedinMemberId) providerToContact.set(String(c.linkedinMemberId), c.id);
      const nk = nameKey(c.name);
      if (nk) nameMap.set(nk, c.id);
    }

    const chats = await getChats(g.externalId);
    if (!chats.length) continue;

    // Phase 1: resolve by the chat's attendee provider-id.
    const resolved = new Map<string, string>();
    const unresolved: any[] = [];
    for (const chat of chats) {
      if (!chat?.id) continue;
      const pid = chat.attendee_provider_id ? String(chat.attendee_provider_id) : null;
      const cid = pid ? providerToContact.get(pid) : undefined;
      if (cid) resolved.set(String(chat.id), cid);
      else unresolved.push(chat);
    }

    // Phase 2: look up attendees (parallel) and match by provider-id or NAME.
    for (let i = 0; i < unresolved.length; i += 10) {
      const slice = unresolved.slice(i, i + 10);
      const lists = await Promise.all(slice.map((c) => getChatAttendees(String(c.id))));
      slice.forEach((chat, j) => {
        for (const a of lists[j] ?? []) {
          if (a?.is_self) continue;
          const apid = a?.provider_id ? String(a.provider_id) : null;
          const byId = apid ? providerToContact.get(apid) : undefined;
          if (byId) {
            resolved.set(String(chat.id), byId);
            break;
          }
          const anm =
            typeof a?.name === "string" ? a.name : typeof a?.display_name === "string" ? a.display_name : null;
          const byName = anm ? nameMap.get(nameKey(anm)) : undefined;
          if (byName) {
            resolved.set(String(chat.id), byName);
            break;
          }
        }
      });
    }

    // Phase 3: fetch messages (parallel) for resolved chats and log them.
    const entries = [...resolved.entries()];
    let n = 0;
    for (let i = 0; i < entries.length; i += 10) {
      const slice = entries.slice(i, i + 10);
      const msgLists = await Promise.all(slice.map(([chatId]) => getChatMessages(chatId)));
      for (let j = 0; j < slice.length; j++) {
        const [chatId, contactId] = slice[j];
        for (const m of (msgLists[j] ?? []).slice(0, PER_CHAT)) {
          if (!m?.id || !m?.timestamp) continue;
          const when = new Date(m.timestamp);
          if (isNaN(when.getTime())) continue;
          await db
            .insert(interactions)
            .values({
              userId: g.userId,
              contactId,
              eventType: m.is_sender ? "message_out" : "message_in",
              direction: m.is_sender ? "outbound" : "inbound",
              channel: "linkedin",
              threadId: chatId,
              occurredAt: when,
              sourceRef: String(m.id),
              metadata: { text: typeof m.text === "string" ? m.text.slice(0, 200) : null },
            })
            .onConflictDoNothing();
          n++;
        }
      }
    }
    console.log(
      `[message-backfill] ${g.userId}: ${chats.length} chats, ${resolved.size} resolved, ${n} messages`,
    );
  }
}
