"use server";

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { calendarEvents, claims, contacts, interactions } from "@/db/schema";
import { extractJSON } from "@/lib/llm";
import { getPrimaryUser, getUserContextRow } from "@/lib/user";
import { getWritingStyleFor } from "@/lib/agent/style";
import { TONE_GUIDE, stripEmDashes } from "@/lib/agent/tone";
import { resolveChannel, deliverOutreach } from "@/lib/outreach/deliver";

const NOTES_KEY = /note|background|summary|description|comment|bio|about/i;

type ReconnectDraft = {
  ok: boolean;
  draft: string;
  why: string;
  channel: "linkedin" | "email" | null;
  channelLabel: string;
  detail?: string;
};

function daysSince(d: Date | string | null): number | null {
  if (!d) return null;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
}

function shortDate(d: Date | string | null): string {
  if (!d) return "";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? "" : dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function channelLabelFor(ch: "linkedin" | "email" | null): string {
  return ch === "linkedin"
    ? "Approve → sends as a LinkedIn DM"
    : ch === "email"
      ? "Approve → sends via email"
      : "No channel on file — copy & send manually";
}

/**
 * Build a personable reconnection draft for ONE contact, reasoning over EVERYTHING we
 * know about the relationship: the user's notes + meeting notes, prior interaction
 * history, past meetings, and any sourced news. Returns the draft, a one-line "why
 * now", and the channel it would send on. On-demand — works on bulk-imported contacts
 * that the automated proactive engine skips (those have no last-contact timestamp).
 */
export async function reconnectDraftAction(contactId: string): Promise<ReconnectDraft> {
  const empty: ReconnectDraft = { ok: false, draft: "", why: "", channel: null, channelLabel: channelLabelFor(null) };
  const user = await getPrimaryUser();
  if (!user || !contactId) return empty;

  const c = (
    await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.userId, user.id)))
      .limit(1)
  )[0];
  if (!c) return empty;

  // --- Gather the relationship history ---
  const cf = (c.customFields ?? {}) as Record<string, string>;
  const notesKey = Object.keys(cf).find((k) => NOTES_KEY.test(k));
  const notes = [cf["Meeting Notes"], notesKey ? cf[notesKey] : "", c.summary ?? ""]
    .filter(Boolean)
    .join(" — ")
    .slice(0, 800);

  const recentInteractions = await db
    .select({
      eventType: interactions.eventType,
      direction: interactions.direction,
      channel: interactions.channel,
      occurredAt: interactions.occurredAt,
      metadata: interactions.metadata,
    })
    .from(interactions)
    .where(eq(interactions.contactId, contactId))
    .orderBy(desc(interactions.occurredAt))
    .limit(8);

  const meetings = await db
    .select({ title: calendarEvents.title, startAt: calendarEvents.startAt, notes: calendarEvents.notes })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.matchedContactId, contactId), eq(calendarEvents.held, true)))
    .orderBy(desc(calendarEvents.startAt))
    .limit(5);

  const newsClaims = await db
    .select({ field: claims.field, value: claims.value, eventDate: claims.eventDate })
    .from(claims)
    .where(eq(claims.contactId, contactId))
    .orderBy(desc(claims.observedAt))
    .limit(5);

  const ctx = await getUserContextRow(user.id);
  const style = await getWritingStyleFor(user.id, "catch_up");

  const lastDays = daysSince(c.lastContactedAt);

  // --- Compose the dossier ---
  const lines: string[] = [];
  lines.push(`Recipient: ${c.name}`);
  if (c.role || c.company) lines.push(`Role/Firm: ${[c.role, c.company].filter(Boolean).join(" @ ")}`);
  lines.push(
    lastDays == null
      ? `Last contacted: no record of a prior touchpoint (imported contact).`
      : `Last contacted: ${lastDays} days ago.`,
  );
  if (notes) lines.push(`What I know about them (my notes): ${notes}`);
  if (meetings.length) {
    lines.push(
      "Past meetings:\n" +
        meetings
          .map((m) => `- ${shortDate(m.startAt)}${m.title ? ` · ${m.title}` : ""}${m.notes ? ` — ${m.notes.slice(0, 220)}` : ""}`)
          .join("\n"),
    );
  }
  if (recentInteractions.length) {
    lines.push(
      "Recent interactions:\n" +
        recentInteractions
          .map((i) => {
            const t = (i.metadata as { text?: string } | null)?.text;
            const dir = i.direction === "outbound" ? "I sent" : i.direction === "inbound" ? "they sent" : i.eventType;
            return `- ${shortDate(i.occurredAt)} · ${i.channel} · ${dir}${t ? `: "${String(t).slice(0, 160)}"` : ""}`;
          })
          .join("\n"),
    );
  }
  if (newsClaims.length) {
    lines.push(
      "Recent news / changes about them:\n" +
        newsClaims.map((n) => `- ${shortDate(n.eventDate)} · ${n.field}: ${n.value.slice(0, 200)}`).join("\n"),
    );
  }
  if (ctx?.currentFocus) lines.push(`My current focus (for relevance, do NOT pitch unless natural): ${ctx.currentFocus}`);

  const res = await extractJSON<{ message: string; why: string }>({
    tier: "strong",
    system:
      "You are Dexa, drafting a reconnection message AS THE USER (first person) to someone they ALREADY KNOW but have not spoken to in a while. " +
      TONE_GUIDE +
      " The goal is a warm, genuine, RELATIONSHIP-FIRST reconnection — not a pitch. Lead with the person, not an ask. " +
      "Ground it in the MOST relevant concrete detail from the history below (a past meeting, a note about them, something they're working on, recent news) — reference ONE specific thing naturally; never list several. " +
      "If there is no concrete detail, write a sincere no-agenda hello. NEVER invent facts, companies, events, or shared history that is not in the dossier. Use the recipient's real first name. Keep it to the short text-message length described above." +
      (style
        ? `\n\nWrite in the user's own voice — their diction, warmth, and characteristic phrasing (ignore any email greetings/sign-offs):\n${style}`
        : ""),
    instruction:
      "Relationship dossier:\n" +
      lines.join("\n") +
      '\n\nReturn JSON: {"message": "<the outreach text, ready to send>", "why": "<one short line: why reconnect now and what detail you anchored on>"}.',
    fallback: { message: "", why: "" },
  });

  const channel = await resolveChannel(c);
  let draft = stripEmDashes((res?.message ?? "").trim());
  // Guard against placeholder/meta leaks; fall back to a clean no-agenda hello.
  if (!draft || /\[[^\]]*\]/.test(draft) || draft.startsWith("[llm-stub")) {
    const first = c.name.split(/\s+/)[0] || "there";
    draft = `${first}, it's been way too long. No agenda — you just came to mind and I wanted to reconnect. Free to catch up sometime soon?`;
  }
  const why =
    (res?.why ?? "").trim() ||
    (lastDays == null
      ? "No prior touchpoint on record — a warm first reconnection."
      : `It's been ${lastDays} days since your last contact.`);

  return { ok: true, draft, why, channel, channelLabel: channelLabelFor(channel) };
}

/**
 * Send an approved (optionally edited) reconnection message to the contact via their
 * channel. Returns the channel it went out on, or a failure detail to surface.
 */
export async function reconnectSendAction(
  contactId: string,
  message: string,
): Promise<{ ok: boolean; channel: "linkedin" | "email" | null; detail: string }> {
  const user = await getPrimaryUser();
  if (!user || !contactId) return { ok: false, channel: null, detail: "not signed in" };
  const text = (message ?? "").trim();
  if (!text) return { ok: false, channel: null, detail: "empty message" };

  const c = (
    await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.userId, user.id)))
      .limit(1)
  )[0];
  if (!c) return { ok: false, channel: null, detail: "contact not found" };

  return deliverOutreach(user.id, c, text);
}
