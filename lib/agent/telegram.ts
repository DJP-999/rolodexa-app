import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, interactions, reminders, suggestions, userContext } from "@/db/schema";
import { answerCallback, finishCard, sendMessage, type ApprovalButton } from "@/lib/integrations/telegram";
import { resolveChannel } from "@/lib/outreach/deliver";
import { SNOOZE_DAYS } from "@/lib/outreach/suppress";
import { buildAgentContext } from "@/lib/agent/context";
import { getWritingStyleFor } from "@/lib/agent/style";
import { complete } from "@/lib/llm";
import { TONE_GUIDE, stripEmDashes } from "@/lib/agent/tone";

type Contact = typeof contacts.$inferSelect;

// ---- Button builders (shared with the webhook) --------------------------------------------

/** After "Reach out": the send controls for a drafted message (keyed by suggestion id). */
export const APPROVE_BUTTONS = (id: string): ApprovalButton[] => [
  { label: "✅ Approve & send", data: `approve:${id}` },
  { label: "✏️ Edit", data: `edit:${id}` },
  { label: "✕ Cancel", data: `cancel:${id}` },
];

/** First-stage controls on a contact card surfaced in chat / a digest (keyed by CONTACT id). */
export const CONTACT_BUTTONS = (cid: string): ApprovalButton[] => [
  { label: "✍️ Reach out", data: `reachC:${cid}` },
  { label: "😴 Snooze", data: `snoozeC:${cid}` },
  { label: "✕ Dismiss", data: `dismissC:${cid}` },
  { label: "🚫 Block", data: `blockC:${cid}` },
];

// ---- Helpers ------------------------------------------------------------------------------

function notesOf(c: Contact): string {
  const cf = (c.customFields ?? {}) as Record<string, string>;
  const key = Object.keys(cf).find((k) => /note|background|summary|description|comment|bio|about/i.test(k));
  return [cf["Meeting Notes"], key ? cf[key] : "", c.summary ?? ""].filter(Boolean).join(" — ").slice(0, 500);
}

function metaLine(c: Contact): string {
  return [c.role, c.company].filter(Boolean).join(" · ");
}

/** Resolve a contact the user named in chat: exact name first, then a confident partial match. */
export async function resolveContactByName(userId: string, name: string): Promise<Contact | null> {
  const n = name.trim().toLowerCase();
  if (n.length < 2) return null;
  const all = await db.select().from(contacts).where(eq(contacts.userId, userId));
  const people = all.filter((c) => !c.isOrganization);
  const exact = people.find((c) => c.name.toLowerCase() === n);
  if (exact) return exact;
  const starts = people.filter((c) => c.name.toLowerCase().startsWith(n));
  if (starts.length === 1) return starts[0];
  const contains = people.filter((c) => c.name.toLowerCase().includes(n));
  if (contains.length === 1) return contains[0];
  // First-name only match, if unambiguous.
  const byFirst = people.filter((c) => c.name.toLowerCase().split(/\s+/)[0] === n);
  if (byFirst.length === 1) return byFirst[0];
  return null;
}

/** Draft a short, warm reconnect note AS the user, in their learned voice. */
async function draftReconnect(c: Contact): Promise<string> {
  const style = await getWritingStyleFor(c.userId, "catch_up");
  const ctx = (await db.select().from(userContext).where(eq(userContext.userId, c.userId)).limit(1))[0];
  const raw = await complete({
    tier: "strong",
    system:
      "You write a reconnection text AS THE USER (first person) to someone they ALREADY KNOW and have met before. " +
      TONE_GUIDE +
      (style ? `\n\nWrite in the user's own voice: ${style}` : ""),
    messages: [
      {
        role: "user",
        content:
          `Reconnect with ${c.name}${metaLine(c) ? `, ${metaLine(c)}` : ""}.` +
          (notesOf(c) ? ` What I know about them: ${notesOf(c)}.` : "") +
          (ctx?.currentFocus ? ` (My focus, context only, do not pitch: ${ctx.currentFocus}.)` : ""),
      },
    ],
    maxTokens: 160,
    temperature: 0.6,
  });
  const t = stripEmDashes((raw ?? "").trim());
  if (t && !t.startsWith("[llm-stub") && !/\[[^\]]*\]/.test(t)) return t;
  const first = c.name.split(/\s+/)[0] || "there";
  return `${first}, it's been too long! No agenda, you just came to mind. Free to catch up soon?`;
}

/** Generate a draft + persist a pending suggestion to hang the Approve/Send flow on. Returns id. */
async function createDraftSuggestion(c: Contact): Promise<string | null> {
  const message = await draftReconnect(c);
  const row = (
    await db
      .insert(suggestions)
      .values({
        userId: c.userId,
        contactId: c.id,
        triggerType: "re_engage",
        reason: `You asked Dexa to reach out to ${c.name}.`,
        draftMessage: message,
        intentLabel: "Reconnect",
        priority: "medium",
        score: 0.6,
        claimIds: [],
      })
      .returning({ id: suggestions.id })
  )[0];
  return row?.id ?? null;
}

async function channelVerb(c: Contact): Promise<string> {
  const ch = await resolveChannel(c);
  return ch === "linkedin"
    ? "Will send as a LinkedIn DM"
    : ch === "email"
      ? "Will send via email"
      : "No channel on file — open Rolodexa to send manually";
}

// ---- Contact-card callback actions (reachC / snoozeC / dismissC / blockC) -------------------

/** Handle a tap on a contact card surfaced in chat or a digest. */
export async function handleContactAction(
  userId: string,
  action: string,
  contactId: string,
  chatId: string,
  callbackId: string,
  messageId?: number,
  origText = "",
): Promise<void> {
  const c = (
    await db.select().from(contacts).where(and(eq(contacts.id, contactId), eq(contacts.userId, userId))).limit(1)
  )[0];
  if (!c) {
    await answerCallback(callbackId, "That contact is no longer available.");
    await finishCard(chatId, messageId, origText, "(no longer available)");
    return;
  }

  if (action === "snoozeC") {
    await db.update(contacts).set({ outreachSnoozedUntil: new Date(Date.now() + SNOOZE_DAYS * 86_400_000) }).where(eq(contacts.id, c.id));
    await answerCallback(callbackId, `Snoozed ${c.name} for 1 month 😴`);
    await finishCard(chatId, messageId, origText, "😴 Snoozed for 1 month");
    return;
  }
  if (action === "dismissC") {
    await db.update(contacts).set({ outreachDismissedAt: new Date() }).where(eq(contacts.id, c.id));
    await answerCallback(callbackId, `Dismissed ${c.name} ✓`);
    await finishCard(chatId, messageId, origText, "✕ Dismissed");
    return;
  }
  if (action === "blockC") {
    await db.update(contacts).set({ outreachBlocked: true }).where(eq(contacts.id, c.id));
    await answerCallback(callbackId, `Blocked — no more updates on ${c.name} 🚫`);
    await finishCard(chatId, messageId, origText, "🚫 Blocked — no more updates");
    return;
  }
  if (action === "reachC") {
    await answerCallback(callbackId, "Drafting…");
    await finishCard(chatId, messageId, origText, "✍️ Reach out — drafting below…");
    const sid = await createDraftSuggestion(c);
    const draft = sid
      ? (await db.select({ d: suggestions.draftMessage }).from(suggestions).where(eq(suggestions.id, sid)).limit(1))[0]?.d
      : null;
    if (sid && draft) {
      await sendMessage(chatId, `Draft to ${c.name} — ${await channelVerb(c)}:\n\n${draft}`, APPROVE_BUTTONS(sid), { plain: true });
    } else {
      await sendMessage(chatId, `Couldn't draft a note for ${c.name} right now. Try again in a moment.`, undefined, { plain: true });
    }
    return;
  }
  await answerCallback(callbackId, "Got it ✓");
}

// ---- Reminders (Telegram as a follow-up notebook) ------------------------------------------

/** Loose gate so we only spend an LLM call when the message smells like a reminder. */
function looksLikeReminder(t: string): boolean {
  return /\bremind me\b|\bset a reminder\b|\breminder to\b|\bnote to self\b|\bdon'?t let me forget\b|\bfollow ?up with\b/i.test(
    t,
  );
}

/**
 * Turn a free-text note into a stored reminder ("remind me early next week to touch base with
 * John Corley and get a meeting scheduled"). Resolves relative dates + the named contact, persists
 * it, and confirms. Returns false if it doesn't parse as a reminder so the caller can fall through.
 */
async function parseAndCreateReminder(userId: string, chatId: string, t: string): Promise<boolean> {
  const now = new Date();
  const raw = await complete({
    tier: "cheap",
    system:
      "You turn a user's message into a follow-up REMINDER. Return JSON only: " +
      `{"isReminder": boolean, "note": "short imperative of what to do", "contactName": string|null, "dueAt": "ISO 8601 datetime"}. ` +
      "Resolve relative times against the current time, in US Eastern: 'early next week' = next Monday 9:00am; 'next week' = next Monday 9am; 'tomorrow' = tomorrow 9am; 'tonight' = today 7pm; 'in an hour' = +1 hour; a weekday name = the next such day at 9am. If no time is stated, use tomorrow 9am. Set isReminder=false only if this clearly is NOT a reminder/follow-up request.",
    messages: [{ role: "user", content: `Current time: ${now.toISOString()} (US Eastern context). Message: ${t}` }],
    maxTokens: 220,
    temperature: 0,
  });
  let parsed: { isReminder?: boolean; note?: string; contactName?: string | null; dueAt?: string };
  try {
    parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
  } catch {
    return false;
  }
  if (!parsed.isReminder || !parsed.note || !parsed.dueAt) return false;
  const due = new Date(parsed.dueAt);
  if (isNaN(due.getTime())) return false;

  const contact = parsed.contactName ? await resolveContactByName(userId, parsed.contactName) : null;
  await db.insert(reminders).values({
    userId,
    contactId: contact?.id ?? null,
    contactName: parsed.contactName ?? contact?.name ?? null,
    note: parsed.note.slice(0, 300),
    dueAt: due,
  });
  const whenStr = due.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
  });
  const who = contact ? ` with ${contact.name}` : parsed.contactName ? ` with ${parsed.contactName}` : "";
  await sendMessage(chatId, `📌 Got it. I'll remind you ${whenStr} to ${parsed.note}${who}.`, undefined, { plain: true });
  return true;
}

/** Handle a tap on a reminder card (✅ Done / ⏰ Tomorrow). */
export async function handleReminderAction(
  userId: string,
  action: string,
  reminderId: string,
  chatId: string,
  callbackId: string,
  messageId?: number,
  origText = "",
): Promise<void> {
  const r = (
    await db.select().from(reminders).where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId))).limit(1)
  )[0];
  if (!r) {
    await answerCallback(callbackId, "That reminder is no longer available.");
    return;
  }
  if (action === "rmsnooze") {
    await db
      .update(reminders)
      .set({ status: "pending", dueAt: new Date(Date.now() + 86_400_000), sentAt: null })
      .where(eq(reminders.id, r.id));
    await answerCallback(callbackId, "I'll remind you again tomorrow ⏰");
    await finishCard(chatId, messageId, origText, "⏰ Snoozed to tomorrow");
    return;
  }
  // default: done
  await db.update(reminders).set({ status: "done" }).where(eq(reminders.id, r.id));
  await answerCallback(callbackId, "Marked done ✓");
  await finishCard(chatId, messageId, origText, "✅ Done");
}

// ---- Off-channel interaction capture ("just had coffee with X…") ---------------------------

/** Gate so we only spend an LLM call when the message smells like logging a real interaction. */
function looksLikeLog(t: string): boolean {
  return /\b(met|meeting|spoke|talked|chatted|caught up|connected|called|hopped on|jumped on|ran into|grabbed|had (a |an )?(call|coffee|lunch|dinner|breakfast|drinks|meeting|chat|sync))\b/i.test(
    t,
  ) && !/\bremind me\b/i.test(t);
}

/**
 * Capture an off-channel touchpoint the user just had ("just had coffee with Sarah Chen, she's
 * hiring a VP Sales, follow up in 2 weeks"). Logs the interaction (so last-contacted updates and
 * going-cold won't false-fire on someone you just saw), saves the note to the contact, and sets a
 * follow-up reminder if mentioned. Returns false if it doesn't parse as a log, to fall through.
 */
async function parseAndLogInteraction(userId: string, chatId: string, t: string): Promise<boolean> {
  const now = new Date();
  const raw = await complete({
    tier: "cheap",
    system:
      "Extract an interaction the user just had with someone, for their relationship CRM. Return JSON only: " +
      `{"isLog": boolean, "contactName": string|null, "kind": "meeting"|"call"|"message"|"event", "occurredAt": ISO 8601, "note": "concise third-person summary of what was discussed or learned (or empty)", "followUp": {"note": string, "dueAt": ISO 8601}|null}. ` +
      "Resolve relative times (today, yesterday, this morning) and follow-up timing ('in 2 weeks', 'next Monday') against the current time, US Eastern; default occurredAt to now. " +
      "isLog is false ONLY if the user is NOT recording an interaction that already happened (e.g. it's a question or a pure reminder).",
    messages: [{ role: "user", content: `Current time: ${now.toISOString()} (US Eastern). Message: ${t}` }],
    maxTokens: 240,
    temperature: 0,
  });
  let p: { isLog?: boolean; contactName?: string | null; kind?: string; occurredAt?: string; note?: string; followUp?: { note?: string; dueAt?: string } | null };
  try {
    p = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
  } catch {
    return false;
  }
  if (!p.isLog || !p.contactName) return false;

  const contact = await resolveContactByName(userId, p.contactName);
  const when = p.occurredAt ? new Date(p.occurredAt) : now;
  const occurredAt = isNaN(when.getTime()) ? now : when;
  const kind = (["meeting", "call", "message", "event"].includes(p.kind ?? "") ? p.kind : "meeting") as string;
  const note = (p.note ?? "").trim();

  // Follow-up reminder (works whether or not the contact is in the rolodex).
  let reminderLine = "";
  if (p.followUp?.note && p.followUp.dueAt) {
    const due = new Date(p.followUp.dueAt);
    if (!isNaN(due.getTime())) {
      await db.insert(reminders).values({
        userId,
        contactId: contact?.id ?? null,
        contactName: p.contactName ?? contact?.name ?? null,
        note: p.followUp.note.slice(0, 300),
        dueAt: due,
      });
      const w = due.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });
      reminderLine = ` Reminder set for ${w} to ${p.followUp.note}.`;
    }
  }

  if (!contact) {
    await sendMessage(
      chatId,
      `I don't see "${p.contactName}" in your rolodex yet, so I couldn't attach the note.${reminderLine} Add them and I'll keep the full history.`,
      undefined,
      { plain: true },
    );
    return true;
  }

  // Log the interaction so it counts toward last-contacted, recency, and KPIs.
  await db
    .insert(interactions)
    .values({
      userId,
      contactId: contact.id,
      eventType: kind === "message" ? "message_out" : "meeting",
      direction: kind === "message" ? "outbound" : null,
      channel: "manual",
      occurredAt,
      sourceRef: `manual:${Date.now()}`,
      metadata: { text: note || `${kind} (logged)`, kind },
    })
    .onConflictDoNothing();

  // Refresh the contact: mark it active again, bump last-contacted, and save the note where the
  // grader and draft-writer will read it.
  const cf = (contact.customFields ?? {}) as Record<string, string>;
  const set: Partial<typeof contacts.$inferInsert> = { status: "active" };
  if (!contact.lastContactedAt || new Date(contact.lastContactedAt).getTime() < occurredAt.getTime()) {
    set.lastContactedAt = occurredAt;
  }
  if (note) {
    const dateStr = occurredAt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    set.customFields = { ...cf, "Meeting Notes": `[${dateStr}] ${note}\n${cf["Meeting Notes"] ?? ""}`.slice(0, 2000) };
  }
  await db.update(contacts).set(set).where(eq(contacts.id, contact.id));

  const kindLabel = kind === "call" ? "call" : kind === "message" ? "note" : kind === "event" ? "run-in" : "meeting";
  await sendMessage(
    chatId,
    `✅ Logged a ${kindLabel} with ${contact.name}.${note ? " Saved your note." : ""}${reminderLine} They're marked active again.`,
    undefined,
    { plain: true },
  );
  return true;
}

// ---- Free-text conversation + commands -----------------------------------------------------

type Command = { verb: "reach" | "snooze" | "dismiss" | "block"; name: string };

/** Parse an explicit action command like "snooze Mitesh" or "draft a note to Nick Larson". */
function parseCommand(text: string): Command | null {
  const t = text.trim();
  let m =
    t.match(/^(?:reach out to|draft (?:a )?(?:note|message|email)?\s*(?:to|for)?|message|write|ping|email)\s+(.+)$/i);
  if (m) return { verb: "reach", name: m[1].trim() };
  m = t.match(/^(?:snooze|mute)\s+(.+)$/i);
  if (m) return { verb: "snooze", name: m[1].trim() };
  m = t.match(/^(?:dismiss|ignore)\s+(.+)$/i);
  if (m) return { verb: "dismiss", name: m[1].trim() };
  m = t.match(/^(?:block|stop updates (?:on|for))\s+(.+)$/i);
  if (m) return { verb: "block", name: m[1].trim() };
  return null;
}

const HELP =
  "👋 I'm Dexa, your relationship assistant. You can just talk to me here. Try:\n\n" +
  "• \"who should I reach out to today?\"\n" +
  "• \"draft a note to Nick Larson\"\n" +
  "• \"snooze Mitesh\" / \"dismiss Tero\" / \"block X\"\n" +
  "• \"what do I know about <company or person>?\"\n" +
  "• \"who in my network works in <industry / role / city>?\"\n\n" +
  "And every update I send has buttons to Reach out, Snooze, Dismiss, or Block in one tap.";

/** Top contacts worth reaching out to now (high relevance, stale or never contacted, not muted). */
async function topReachOut(userId: string, n: number): Promise<Contact[]> {
  const all = await db.select().from(contacts).where(eq(contacts.userId, userId));
  const now = Date.now();
  return all
    .filter((c) => !c.isOrganization && !c.outreachBlocked && (c.relevance ?? 0) >= 40)
    .filter((c) => !(c.outreachSnoozedUntil && new Date(c.outreachSnoozedUntil).getTime() > now))
    .map((c) => {
      const lastDays = c.lastContactedAt ? (now - new Date(c.lastContactedAt).getTime()) / 86_400_000 : 9999;
      return { c, score: (c.relevance ?? 0) + Math.min(60, lastDays / 10) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.c);
}

/**
 * The Telegram brain. Routes a free-text message to: a direct command (with confirmation /
 * draft buttons), a "who should I reach out to" actionable list, or a conversational answer
 * grounded in the user's real network.
 */
export async function handleDexaText(userId: string, chatId: string, text: string): Promise<void> {
  const t = text.trim();
  if (!t) return;

  if (/^\/?(start|help|menu)\b/i.test(t)) {
    await sendMessage(chatId, HELP, undefined, { plain: true });
    return;
  }

  // 1) Direct command on a named contact.
  const cmd = parseCommand(t);
  if (cmd) {
    const c = await resolveContactByName(userId, cmd.name);
    if (!c) {
      await sendMessage(chatId, `I don't see "${cmd.name}" in your rolodex. Want me to search by company instead?`, undefined, { plain: true });
      return;
    }
    if (cmd.verb === "reach") {
      const sid = await createDraftSuggestion(c);
      const draft = sid
        ? (await db.select({ d: suggestions.draftMessage }).from(suggestions).where(eq(suggestions.id, sid)).limit(1))[0]?.d
        : null;
      if (sid && draft) {
        await sendMessage(chatId, `Draft to ${c.name} — ${await channelVerb(c)}:\n\n${draft}`, APPROVE_BUTTONS(sid), { plain: true });
      } else {
        await sendMessage(chatId, `Couldn't draft that right now. Try again in a moment.`, undefined, { plain: true });
      }
      return;
    }
    const patch =
      cmd.verb === "snooze"
        ? { outreachSnoozedUntil: new Date(Date.now() + SNOOZE_DAYS * 86_400_000) }
        : cmd.verb === "dismiss"
          ? { outreachDismissedAt: new Date() }
          : { outreachBlocked: true };
    await db.update(contacts).set(patch).where(eq(contacts.id, c.id));
    const note =
      cmd.verb === "snooze"
        ? `Snoozed ${c.name} for 1 month 😴`
        : cmd.verb === "dismiss"
          ? `Dismissed ${c.name} ✓`
          : `Blocked ${c.name} — no more updates 🚫`;
    await sendMessage(chatId, note, undefined, { plain: true });
    return;
  }

  // 1.4) Log an off-channel interaction ("just had coffee with Sarah, she's hiring, follow up in 2w").
  // Checked before reminders since a log often carries its own follow-up.
  if (looksLikeLog(t)) {
    const ok = await parseAndLogInteraction(userId, chatId, t);
    if (ok) return;
  }

  // 1.5) Reminder / note-to-self ("remind me early next week to follow up with John Corley").
  if (looksLikeReminder(t)) {
    const ok = await parseAndCreateReminder(userId, chatId, t);
    if (ok) return;
  }

  // 2) "Who should I reach out to" → actionable cards.
  if (/\bwho\b.*\b(reach|contact|follow ?up|connect|catch up|message)\b|reach out to(?:day)?\b|top (?:contacts|people)|who.*today/i.test(t)) {
    const list = await topReachOut(userId, 5);
    if (!list.length) {
      await sendMessage(chatId, "Your network's all warm right now, nobody overdue. Ask me about anyone specific and I'll pull them up.", undefined, { plain: true });
      return;
    }
    await sendMessage(chatId, `Here are ${list.length} worth reaching out to:`, undefined, { plain: true });
    for (const c of list) {
      const lastDays = c.lastContactedAt ? Math.floor((Date.now() - new Date(c.lastContactedAt).getTime()) / 86_400_000) : null;
      const when = lastDays === null ? "no touch on record" : `last touch ${lastDays}d ago`;
      await sendMessage(chatId, `${c.name}${metaLine(c) ? ` — ${metaLine(c)}` : ""}\n${when} · relevance ${c.relevance ?? "—"}`, CONTACT_BUTTONS(c.id), { plain: true });
    }
    return;
  }

  // 3) Conversational — grounded in the real network.
  const ctx = (await db.select().from(userContext).where(eq(userContext.userId, userId)).limit(1))[0];
  const context = await buildAgentContext(userId, t);
  const reply = await complete({
    tier: "strong",
    system:
      `You are Dexa, the relationship assistant for ${ctx?.role ?? "a professional who stays close to their network at scale"}, replying inside Telegram. ` +
      "Be warm, concise, and specific, like a sharp chief-of-staff texting back. Use ONLY the CONTEXT for facts about specific people; if someone isn't in it, say you don't see them in the loaded set rather than inventing. " +
      "If they clearly want to act on someone (reach out, snooze, dismiss, block), tell them they can just say e.g. 'draft a note to <name>' or 'snooze <name>'. " +
      "Never use em-dashes or en-dashes; use periods or commas.\n\n=== CONTEXT ===\n" +
      context,
    messages: [{ role: "user", content: t }],
    maxTokens: 700,
  });
  await sendMessage(chatId, stripEmDashes(reply), undefined, { plain: true });
}
