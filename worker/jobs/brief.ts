import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  calendarEvents,
  claims,
  connectedAccounts,
  contacts,
  interactions,
  notificationEvents,
  suggestions,
  userContext,
  users,
} from "@/db/schema";
import {
  notificationGate,
  deriveSuppressedCategories,
  type GateContext,
} from "@/lib/notifications/gate";
import { sendMessage, contactLink, htmlEscape } from "@/lib/integrations/telegram";
import { CONTACT_BUTTONS } from "@/lib/agent/telegram";
import { outreachSuppressed, isNewsTrigger } from "@/lib/outreach/suppress";
import { cadenceForRelevance } from "@/lib/scoring/relevance";

function headerFor(slug: string): string {
  return slug === "night-brief" ? "🌙 Night brief" : slug === "midday-update" ? "🔆 Midday update" : "☀️ Morning brief";
}

/**
 * Fallback so a brief is NEVER silent: when nothing clears the gate, send a single light
 * digest of the relationships most worth warming up (high relevance + stale or never
 * contacted), pointing at the one-tap Reconnect button. No buttons, no daily-cap spend.
 */
async function sendColdDigest(userId: string, email: string, slug: string): Promise<void> {
  const tg = (
    await db
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, "telegram")))
      .limit(1)
  )[0];
  if (!tg?.externalId) {
    console.log(`[brief:${slug}] no telegram chat for ${email}`);
    return;
  }

  const rows = await db.select().from(contacts).where(eq(contacts.userId, userId));
  const cold = rows
    // Cold digest is a check-in nudge (non-news), so honor block/snooze/dismiss here too.
    .filter((c) => !c.isOrganization && (c.relevance ?? 0) >= 35 && !outreachSuppressed(c, false).suppressed)
    .map((c) => {
      const last = c.lastContactedAt
        ? Math.floor((Date.now() - new Date(c.lastContactedAt).getTime()) / 86_400_000)
        : null;
      const cadence = cadenceForRelevance(c.relevance ?? null);
      const stale = last === null || last > cadence;
      const staleScore = last === null ? cadence + 30 : last - cadence;
      return { c, last, stale, pr: (c.relevance ?? 0) + Math.max(0, staleScore) / 10 };
    })
    .filter((x) => x.stale)
    .sort((a, b) => b.pr - a.pr)
    .slice(0, 3);

  if (!cold.length) {
    console.log(`[brief:${slug}] NO_MESSAGE (network all warm) for ${email}`);
    return;
  }

  // Actionable, not a dead list: a header, then one card per contact with one-tap controls so
  // even a "nothing urgent" brief can be acted on entirely from Telegram.
  await sendMessage(
    tg.externalId,
    `${headerFor(slug)} — nothing urgent, but ${cold.length} relationship${cold.length > 1 ? "s" : ""} worth warming up:`,
    undefined,
    { plain: true },
  );
  for (const { c, last } of cold) {
    const meta = [c.role, c.company].filter(Boolean).join(" · ");
    const when = last === null ? "no touch on record" : `last touch ${last}d ago`;
    const name = contactLink(c.name, c.linkedinUrl); // tap the name to vet them on LinkedIn
    await sendMessage(
      tg.externalId,
      `${name}${meta ? ` — ${htmlEscape(meta)}` : ""}\n${htmlEscape(when)} · relevance ${c.relevance ?? "—"}`,
      CONTACT_BUTTONS(c.id),
      { html: true },
    );
  }
  console.log(`[brief:${slug}] sent actionable cold digest (${cold.length}) to ${email}`);
}

/**
 * End-of-day meeting recap. For every calendar meeting with a known contact that ENDED today
 * and hasn't been confirmed, ask "did it hold?" with one-tap Yes/No. Confirming logs it as a real
 * touch (contact marked freshly contacted → quiet for weeks) — so the user never has to log a
 * meeting manually, and we ask the same day while it's fresh instead of 2 weeks later.
 * Returns how many confirmations we asked for. Night-brief only.
 */
async function confirmTodaysMeetings(userId: string, chatId: string): Promise<number> {
  const now = Date.now();
  const dayAgo = new Date(now - 26 * 3_600_000); // today-ish window (a little over 24h of slack)
  const rows = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.userId, userId),
        isNotNull(calendarEvents.matchedContactId),
        isNull(calendarEvents.held),
        isNull(calendarEvents.confirmPromptedAt),
        eq(calendarEvents.allDay, false),
        gte(calendarEvents.startAt, dayAgo),
      ),
    )
    .orderBy(desc(calendarEvents.startAt));

  // Only meetings that have actually ended (use endAt, else assume ~1h). Cap so a heavy day
  // doesn't flood Telegram; the rest get picked up on the next night brief.
  const ended = rows
    .filter((e) => {
      const end = e.endAt ? new Date(e.endAt).getTime() : new Date(e.startAt).getTime() + 3_600_000;
      return end < now;
    })
    .slice(0, 6);
  if (!ended.length) return 0;

  await sendMessage(
    chatId,
    `🌙 Before you wrap up — did ${ended.length === 1 ? "this meeting" : `these ${ended.length} meetings`} hold? One tap logs it so I keep their timeline right.`,
    undefined,
    { plain: true },
  );

  let asked = 0;
  for (const e of ended) {
    const c = e.matchedContactId
      ? (await db.select().from(contacts).where(eq(contacts.id, e.matchedContactId)).limit(1))[0]
      : undefined;
    if (!c) continue;
    const name = contactLink(c.name, c.linkedinUrl);
    const title = e.title ? ` — ${htmlEscape(e.title)}` : "";
    const when = shortDate(e.startAt);
    await sendMessage(
      chatId,
      `📅 Did your meeting with ${name}${title}${when ? ` (${htmlEscape(when)})` : ""} hold?`,
      [
        { label: "✅ Yes, we met", data: `mheld:${e.id}` },
        { label: "✕ Didn't happen", data: `mmiss:${e.id}` },
      ],
      { html: true },
    );
    await db.update(calendarEvents).set({ confirmPromptedAt: new Date() }).where(eq(calendarEvents.id, e.id));
    asked++;
  }
  console.log(`[brief:night] asked ${asked} meeting confirmation(s) for ${userId}`);
  return asked;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function shortDate(d: string | Date | null): string {
  if (!d) return "";
  const dt = new Date(typeof d === "string" && d.length <= 10 ? `${d}T00:00:00` : d);
  return isNaN(dt.getTime()) ? "" : dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Brief composer for one cadence. Ranks pending suggestions, runs each through the
 * notification gate + daily cap, and delivers the survivors to Telegram — one message
 * per suggestion with Approve / Edit / Decline buttons that actually send the outreach.
 */
export async function runBrief(slug: string): Promise<void> {
  const us = await db.select().from(users);
  for (const u of us) {
    const ctx = (await db.select().from(userContext).where(eq(userContext.userId, u.id)).limit(1))[0];
    const maxNudges = ctx?.maxNudgesPerDay ?? 3;

    // End-of-day: ask "did today's meetings hold?" so touches get logged same-day with one tap,
    // independent of whether there are any pending suggestions to review.
    if (slug === "night-brief") {
      const chat = (
        await db
          .select({ ext: connectedAccounts.externalId })
          .from(connectedAccounts)
          .where(and(eq(connectedAccounts.userId, u.id), eq(connectedAccounts.provider, "telegram")))
          .limit(1)
      )[0]?.ext;
      if (chat) await confirmTodaysMeetings(u.id, chat).catch((e) => console.error("[brief:night] confirm", e));
    }

    const pending = await db
      .select()
      .from(suggestions)
      .where(
        and(
          eq(suggestions.userId, u.id),
          eq(suggestions.status, "pending"),
          isNull(suggestions.notifiedAt),
        ),
      )
      .orderBy(desc(suggestions.score))
      .limit(15);
    if (!pending.length) {
      await sendColdDigest(u.id, u.email, slug);
      continue;
    }

    const sentRows = await db
      .select({ id: notificationEvents.id })
      .from(notificationEvents)
      .where(and(eq(notificationEvents.userId, u.id), gte(notificationEvents.sentAt, startOfToday())));
    const sentToday = sentRows.length;

    const recent = await db
      .select({ category: notificationEvents.category, outcome: notificationEvents.outcome })
      .from(notificationEvents)
      .where(
        and(
          eq(notificationEvents.userId, u.id),
          gte(notificationEvents.sentAt, new Date(Date.now() - 14 * 86_400_000)),
        ),
      );
    const suppressed = deriveSuppressedCategories(
      recent.map((r) => ({ category: r.category, outcome: r.outcome ?? "sent" })),
    );

    const baseCtx: Omit<GateContext, "sentToday"> = {
      observationUntil: ctx?.observationUntil ?? null,
      gateConfidence: ctx?.gateConfidence ?? 0.6,
      gateReplyPropensity: ctx?.gateReplyPropensity ?? 0.4,
      gateProjectMatch: ctx?.gateProjectMatch ?? 0.55,
      maxNudgesPerDay: maxNudges,
      suppressedCategories: suppressed,
    };

    // Latest OUTBOUND time per contact — to drop nudges the user has already acted on.
    const outRows = await db
      .select({ contactId: interactions.contactId, at: interactions.occurredAt })
      .from(interactions)
      .where(and(eq(interactions.userId, u.id), eq(interactions.direction, "outbound"), isNotNull(interactions.contactId)))
      .orderBy(desc(interactions.occurredAt));
    const latestOut = new Map<string, number>();
    for (const r of outRows) {
      const cid = r.contactId;
      if (cid && !latestOut.has(cid)) latestOut.set(cid, new Date(r.at).getTime());
    }

    type Row = (typeof pending)[number] & { contact?: typeof contacts.$inferSelect };
    const passed: Row[] = [];
    for (const s of pending) {
      if (passed.length >= maxNudges) break;
      // STALE-CHECK: if the user has reached out to this contact SINCE the nudge was generated, it's
      // moot (they already handled it) — drop it so we never nudge about someone just contacted.
      const reachedOutAt = s.contactId ? latestOut.get(s.contactId) : undefined;
      if (reachedOutAt && reachedOutAt > new Date(s.createdAt).getTime()) {
        await db.update(suggestions).set({ status: "dismissed", updatedAt: new Date() }).where(eq(suggestions.id, s.id));
        continue;
      }
      const contact = s.contactId
        ? (await db.select().from(contacts).where(eq(contacts.id, s.contactId)).limit(1))[0]
        : undefined;
      // Respect the Telegram controls (block / snooze / dismiss) before spending a nudge slot.
      if (contact && outreachSuppressed(contact, isNewsTrigger(s.triggerType)).suppressed) continue;
      const g = notificationGate(
        { ...baseCtx, sentToday: sentToday + passed.length },
        {
          confidence: s.score ?? 0.5,
          replyPropensity: contact?.replyPropensity ?? 0,
          projectMatch: 0.5,
          category: s.triggerType,
          highValue: contact?.highValue ?? false,
        },
      );
      if (g.pass) passed.push({ ...s, contact });
    }

    if (!passed.length) {
      await sendColdDigest(u.id, u.email, slug);
      continue;
    }

    const tg = (
      await db
        .select()
        .from(connectedAccounts)
        .where(and(eq(connectedAccounts.userId, u.id), eq(connectedAccounts.provider, "telegram")))
        .limit(1)
    )[0];
    if (!tg?.externalId) {
      console.log(`[brief:${slug}] no telegram chat for ${u.email}`);
      continue;
    }

    const claimIds = passed.flatMap((s) => s.claimIds ?? []);
    const freshClaims = claimIds.length
      ? await db.select().from(claims).where(inArray(claims.id, claimIds))
      : [];
    const claimById = new Map(freshClaims.map((c) => [c.id, c]));

    const header =
      slug === "night-brief" ? "🌙 Night brief" : slug === "midday-update" ? "🔆 Midday update" : "☀️ Morning brief";
    await sendMessage(tg.externalId, `${header} — ${passed.length} to review`, undefined, { plain: true });

    let sent = 0;
    for (const s of passed) {
      const c = s.contact;
      const claim = (s.claimIds ?? []).map((id) => claimById.get(id)).find((x) => x?.sourceUrl);
      const when = claim ? shortDate(claim.publishedDate ?? claim.eventDate) : "";
      const srcLine = claim?.sourceUrl ? `\n${when ? `${when} · ` : ""}${claim.sourceUrl}` : "";
      const meta = [c?.role, c?.company].filter(Boolean).join(" · ");
      // First stage: the update + four controls. The draft + channel are only revealed once you
      // tap Reach out, so the brief stays a quick triage rather than a wall of pre-written notes.
      // The name links to LinkedIn so the user can vet the contact before deciding to reach out.
      const name = contactLink(c?.name ?? "Contact", c?.linkedinUrl);
      const itemText = `${name}${meta ? ` — ${htmlEscape(meta)}` : ""}\n${htmlEscape(s.reason)}${htmlEscape(srcLine)}`;
      // For reconnect-type nudges, offer a zero-effort "we already spoke" so the user can log an
      // off-channel meeting with one tap — which marks them contacted and quiets nudges for weeks.
      const reconnectish = ["re_engage", "follow_up", "going_cold"].includes(s.triggerType);
      const buttons = [
        { label: "✍️ Reach out", data: `reach:${s.id}` },
        ...(reconnectish ? [{ label: "✅ We spoke", data: `spoke:${s.id}` }] : []),
        { label: "😴 Snooze", data: `snooze:${s.id}` },
        { label: "✕ Dismiss", data: `dismiss:${s.id}` },
        { label: "🚫 Block", data: `block:${s.id}` },
      ];
      const ok = await sendMessage(tg.externalId, itemText, buttons, { html: true });
      if (ok) {
        sent++;
        await db.insert(notificationEvents).values({
          userId: u.id,
          suggestionId: s.id,
          contactId: s.contactId ?? null,
          triggerType: s.triggerType,
          category: s.triggerType,
          channel: "telegram",
          sentAt: new Date(),
          outcome: "sent",
        });
        await db.update(suggestions).set({ notifiedAt: new Date() }).where(eq(suggestions.id, s.id));
      }
    }
    console.log(`[brief:${slug}] delivered ${sent}/${passed.length} item(s) to ${u.email}`);
  }
}
