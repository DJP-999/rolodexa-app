import { eq } from "drizzle-orm";
import { db } from "@/db";
import { connectedAccounts, contacts, interactions } from "@/db/schema";
import { getChatAttendees, getChatMessages, getChats, unipileConfigured } from "@/lib/integrations/unipile";
import { nameKey } from "@/lib/match/entity";
import { env } from "@/lib/env";
import { runRecompute } from "./recompute";

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
    const slugToContact = new Map<string, string>();
    for (const c of list) {
      if (c.linkedinMemberId) providerToContact.set(String(c.linkedinMemberId), c.id);
      const nk = nameKey(c.name);
      if (nk) nameMap.set(nk, c.id);
      // The LinkedIn public slug (from the profile URL) is a stable key — far more reliable
      // than fuzzy name matching for contacts without a stored member-id.
      const sm = (c.linkedinUrl ?? "").match(/\/in\/([^/?#]+)/i);
      if (sm) slugToContact.set(decodeURIComponent(sm[1]).toLowerCase(), c.id);
    }

    // Find a LinkedIn /in/<slug> anywhere in an object (chat or attendee), match to a contact.
    const slugMatch = (obj: unknown): string | undefined => {
      const m = JSON.stringify(obj ?? "").match(/\/in\/([^/?#"\\]+)/i);
      return m ? slugToContact.get(decodeURIComponent(m[1]).toLowerCase()) : undefined;
    };

    const chats = await getChats(g.externalId, undefined, env.MESSAGE_BACKFILL_CHAT_CAP);
    if (!chats.length) continue;

    // Phase 1: resolve by the chat's attendee provider-id, then by any profile slug on the chat.
    const resolved = new Map<string, string>();
    const unresolved: any[] = [];
    for (const chat of chats) {
      if (!chat?.id) continue;
      const pid = chat.attendee_provider_id ? String(chat.attendee_provider_id) : null;
      const cid = (pid ? providerToContact.get(pid) : undefined) ?? slugMatch(chat);
      if (cid) resolved.set(String(chat.id), cid);
      else unresolved.push(chat);
    }

    // Phase 2: look up attendees (parallel) and match by provider-id, profile SLUG, then name.
    // Phase 1 (id/slug from the chat object) already covers the reliable matches across ALL
    // chats cheaply; attendee lookups are the slow part, so bound them at a high inbox depth.
    const toLookUp = unresolved.slice(0, env.MESSAGE_BACKFILL_ATTENDEE_LOOKUPS);
    for (let i = 0; i < toLookUp.length; i += 10) {
      const slice = toLookUp.slice(i, i + 10);
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
          const bySlug = slugMatch(a);
          if (bySlug) {
            resolved.set(String(chat.id), bySlug);
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

    // --- Targeted diagnostic (only when DEBUG_BACKFILL_NAME is set) ---
    if (env.DEBUG_BACKFILL_NAME) {
      const want = nameKey(env.DEBUG_BACKFILL_NAME);
      const lastTok = want.split(" ").pop() ?? want;
      const resolvedIds = new Set(resolved.values());
      const targets = list.filter((c) => {
        const k = nameKey(c.name);
        return k === want || k.includes(want) || (lastTok.length >= 3 && k.includes(lastTok));
      });
      console.log(`[backfill-debug] target "${env.DEBUG_BACKFILL_NAME}" → ${targets.length} matching contact(s)`);
      for (const t of targets) {
        const slug = (t.linkedinUrl ?? "").match(/\/in\/([^/?#]+)/i)?.[1] ?? null;
        console.log(
          `[backfill-debug] contact "${t.name}" id=${t.id} memberId=${t.linkedinMemberId ?? "NONE"} url=${
            t.linkedinUrl ?? "NONE"
          } slug=${slug ?? "NONE"} resolvedToAChat=${resolvedIds.has(t.id)}`,
        );
      }
      // Does ANY synced chat reference the target (by last-name token or slug)?
      const re = new RegExp(lastTok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const hits = chats.filter((ch) => re.test(JSON.stringify(ch ?? "")));
      console.log(`[backfill-debug] ${hits.length}/${chats.length} synced chats mention "${lastTok}"`);
      for (const ch of hits.slice(0, 5)) {
        console.log(
          `[backfill-debug] chat id=${ch.id} attendee_provider_id=${ch.attendee_provider_id ?? "?"} chatJson=${JSON.stringify(ch).slice(0, 500)}`,
        );
        const atts = await getChatAttendees(String(ch.id));
        console.log(`[backfill-debug]   attendees=${JSON.stringify(atts).slice(0, 900)}`);
      }
      if (!hits.length) {
        console.log(
          `[backfill-debug] CONCLUSION: no synced chat references "${lastTok}" — the conversation is NOT in the connected LinkedIn account's chat list (likely InMail, a filtered/Other inbox, or a different account). App-side matching cannot recover what Unipile doesn't return.`,
        );
      }
    }
  }

  // Surface the freshly-logged history: lastContactedAt is derived (max occurredAt over a
  // contact's interactions), so recompute makes the "Last interaction" column reflect the backfill.
  await runRecompute();
}
