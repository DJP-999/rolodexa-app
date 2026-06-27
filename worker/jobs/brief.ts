import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  claims,
  connectedAccounts,
  contacts,
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
import { sendMessage } from "@/lib/integrations/telegram";
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

  const lines = cold.map(({ c, last }) => {
    const meta = [c.role, c.company].filter(Boolean).join(" · ");
    const when = last === null ? "no touch on record" : `last touch ${last}d ago`;
    return `• ${c.name}${meta ? ` — ${meta}` : ""} (${when})`;
  });
  const body =
    `${headerFor(slug)} — nothing urgent today.\n\n` +
    `${cold.length} relationship${cold.length > 1 ? "s" : ""} worth warming up:\n` +
    lines.join("\n") +
    `\n\nOpen Rolodexa and tap Reconnect to send a personal note in one tap.`;
  await sendMessage(tg.externalId, body, undefined, { plain: true });
  console.log(`[brief:${slug}] sent cold digest (${cold.length}) to ${email}`);
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

    type Row = (typeof pending)[number] & { contact?: typeof contacts.$inferSelect };
    const passed: Row[] = [];
    for (const s of pending) {
      if (passed.length >= maxNudges) break;
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
      const itemText = `${c?.name ?? "Contact"}${meta ? ` — ${meta}` : ""}\n${s.reason}${srcLine}`;
      const ok = await sendMessage(
        tg.externalId,
        itemText,
        [
          { label: "✍️ Reach out", data: `reach:${s.id}` },
          { label: "😴 Snooze", data: `snooze:${s.id}` },
          { label: "✕ Dismiss", data: `dismiss:${s.id}` },
          { label: "🚫 Block", data: `block:${s.id}` },
        ],
        { plain: true },
      );
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
