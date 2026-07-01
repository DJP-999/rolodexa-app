import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { connectedAccounts, contacts, interactions, suggestions } from "@/db/schema";
import { outreachSuppressed } from "@/lib/outreach/suppress";
import { getWritingStyleFor } from "@/lib/agent/style";
import { resolveChannel } from "@/lib/outreach/deliver";
import { sendMessage, contactLink, htmlEscape } from "@/lib/integrations/telegram";
import { APPROVE_BUTTONS } from "@/lib/agent/telegram";
import { draft } from "./suggestions";

type Contact = typeof contacts.$inferSelect;
type Ix = typeof interactions.$inferSelect;
type Trigger = "reply" | "follow_up" | "going_cold";

const DAY = 86_400_000;
const REPLY_WINDOW_DAYS = 3; // a reply still worth surfacing
const FOLLOWUP_MIN_DAYS = 14; // two weeks of silence before nudging a follow-up (avoid being pushy)
const FOLLOWUP_MAX_DAYS = 28; // ...but past this it's stale, drop it
const RELEVANCE_FLOOR = 35;
const MAX_NEW_PER_RUN = 40; // bound LLM drafting cost
const MAX_REPLY_PINGS_PER_RUN = 5; // immediate Telegram pings per run

const isOut = (i: Ix) => i.direction === "outbound";
const isIn = (i: Ix) => i.direction === "inbound";
const snippetOf = (i?: Ix | null): string => {
  const m = (i?.metadata ?? {}) as { subject?: string; text?: string };
  return (m.text || m.subject || "").toString().trim().slice(0, 160);
};

async function pending(userId: string, contactId: string, trigger: Trigger): Promise<boolean> {
  const r = await db
    .select({ id: suggestions.id })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.userId, userId),
        eq(suggestions.contactId, contactId),
        eq(suggestions.triggerType, trigger),
        eq(suggestions.status, "pending"),
      ),
    )
    .limit(1);
  return r.length > 0;
}

const priorityOf = (s: number): "high" | "medium" | "low" => (s > 0.6 ? "high" : s > 0.4 ? "medium" : "low");

/**
 * The follow-through + going-cold engine — so no important relationship slips through the cracks:
 *  • reply      → they responded and the ball is in your court (surfaced FAST to Telegram).
 *  • follow_up  → you reached out and got silence; nudge a gentle bump before the thread dies.
 *  • going_cold → a relationship that was warm is slipping; rekindle it.
 * Runs hourly. Reply nudges are pushed immediately; follow-ups and going-cold flow through the
 * normal briefs. Bounded per run to cap drafting cost.
 */
export async function runFollowThrough(): Promise<void> {
  const allContacts = await db.select().from(contacts);
  const allIx = await db.select().from(interactions);

  const byContact = new Map<string, Ix[]>();
  for (const it of allIx) {
    if (!it.contactId) continue;
    (byContact.get(it.contactId) ?? byContact.set(it.contactId, []).get(it.contactId)!).push(it);
  }

  const styleByUser = new Map<string, string | null>();
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

  const now = Date.now();
  // Most-relevant first so the per-run budget lands on the contacts that matter.
  const people = allContacts
    .filter((c) => !c.isOrganization)
    .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));

  let created = 0;
  let replyPings = 0;

  for (const c of people) {
    if (created >= MAX_NEW_PER_RUN) break;
    if (c.outreachBlocked) continue;
    if (c.outreachSnoozedUntil && new Date(c.outreachSnoozedUntil).getTime() > now) continue;
    const important = (c.relevance ?? 0) >= RELEVANCE_FLOOR || c.highValue;
    if (!important) continue;

    const ix = (byContact.get(c.id) ?? []).slice().sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
    const lastIn = ix.find(isIn) ?? null;
    const lastOut = ix.find(isOut) ?? null;
    const inAt = lastIn ? new Date(lastIn.occurredAt).getTime() : 0;
    const outAt = lastOut ? new Date(lastOut.occurredAt).getTime() : 0;

    // 1) REPLY — they spoke last (after your outbound) and recently. Ball in your court.
    if (
      lastIn &&
      lastOut &&
      inAt > outAt &&
      now - inAt <= REPLY_WINDOW_DAYS * DAY &&
      !outreachSuppressed(c, true).suppressed &&
      !(await pending(c.userId, c.id, "reply"))
    ) {
      if (!styleByUser.has(c.userId)) styleByUser.set(c.userId, await getWritingStyleFor(c.userId, "catch_up"));
      const theirMsg = snippetOf(lastIn);
      const message = await draft({
        name: c.name,
        trigger:
          `They just replied to you${theirMsg ? `: "${theirMsg}"` : ""}. Write a short, warm reply that responds naturally and moves things forward (e.g. suggest finding a time).`,
        style: styleByUser.get(c.userId) ?? null,
      });
      const score = Math.min(1, (c.relevance ?? 40) / 100 + 0.3);
      const sid = (
        await db
          .insert(suggestions)
          .values({
            userId: c.userId,
            contactId: c.id,
            triggerType: "reply",
            reason: `💬 ${c.name} replied${theirMsg ? `: "${theirMsg}"` : ""} — your move.`,
            draftMessage: message,
            intentLabel: "Reply",
            priority: priorityOf(score),
            score,
            claimIds: [],
            notifiedAt: new Date(), // pushed immediately below; keep the brief from double-sending
          })
          .returning({ id: suggestions.id })
      )[0]?.id;
      created++;

      // Surface fast: push the suggested response straight to Telegram with send controls.
      const chat = await chatFor(c.userId);
      if (chat && sid && replyPings < MAX_REPLY_PINGS_PER_RUN) {
        const ch = await resolveChannel(c);
        const via = ch === "linkedin" ? "LinkedIn DM" : ch === "email" ? "email" : "no channel on file";
        await sendMessage(
          chat,
          `💬 ${contactLink(c.name, c.linkedinUrl)} replied — suggested response (${via}):\n\n${htmlEscape(message)}`,
          APPROVE_BUTTONS(sid),
          { html: true },
        );
        replyPings++;
      }
      continue; // one trigger per contact per run
    }

    // 2) FOLLOW-UP — you reached out, silence for a while. Gentle bump before it dies.
    const silentDays = lastOut && outAt >= inAt ? (now - outAt) / DAY : null;
    if (
      silentDays !== null &&
      silentDays >= FOLLOWUP_MIN_DAYS &&
      silentDays <= FOLLOWUP_MAX_DAYS &&
      !outreachSuppressed(c, false).suppressed &&
      !(await pending(c.userId, c.id, "follow_up"))
    ) {
      if (!styleByUser.has(c.userId)) styleByUser.set(c.userId, await getWritingStyleFor(c.userId, "catch_up"));
      const message = await draft({
        name: c.name,
        trigger: `You reached out about ${Math.round(silentDays)} days ago and haven't heard back. Write a short, friendly, low-pressure follow-up that gently bumps the thread.`,
        style: styleByUser.get(c.userId) ?? null,
      });
      const score = Math.min(1, ((c.relevance ?? 0) / 100) * 0.85 + 0.2);
      await db.insert(suggestions).values({
        userId: c.userId,
        contactId: c.id,
        triggerType: "follow_up",
        reason: `⏳ You reached out to ${c.name} ${Math.round(silentDays)}d ago with no reply on record. Did you two already connect, or want to follow up?`,
        draftMessage: message,
        intentLabel: "Follow up",
        priority: priorityOf(score),
        score,
        claimIds: [],
      });
      created++;
      continue;
    }

    // 3) GOING COLD — a relationship that was warm is slipping.
    if (
      c.status === "going_cold" &&
      !outreachSuppressed(c, false).suppressed &&
      !(await pending(c.userId, c.id, "going_cold"))
    ) {
      if (!styleByUser.has(c.userId)) styleByUser.set(c.userId, await getWritingStyleFor(c.userId, "catch_up"));
      const lastDays = c.lastContactedAt ? Math.round((now - new Date(c.lastContactedAt).getTime()) / DAY) : null;
      const message = await draft({
        name: c.name,
        trigger: `You were in regular touch but it's cooling off${lastDays ? ` (about ${lastDays} days quiet)` : ""}. Write a warm, no-agenda note to rekindle the relationship.`,
        style: styleByUser.get(c.userId) ?? null,
      });
      const score = Math.min(1, ((c.relevance ?? 0) / 100) * 0.8 + 0.2);
      await db.insert(suggestions).values({
        userId: c.userId,
        contactId: c.id,
        triggerType: "going_cold",
        reason: `❄️ ${c.name} is going cold${lastDays ? ` (${lastDays}d quiet)` : ""} — rekindle it.`,
        draftMessage: message,
        intentLabel: "Rekindle",
        priority: priorityOf(score),
        score,
        claimIds: [],
      });
      created++;
    }
  }

  console.log(`[follow-through] created ${created} suggestion(s), ${replyPings} reply ping(s)`);
}
