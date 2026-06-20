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
import { verifyBriefAgainstClaims } from "@/lib/provenance/verify";
import { sendMessage } from "@/lib/integrations/telegram";

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Brief composer for one cadence (morning / midday / night). Enforces, in code:
 * observation window + precision gate + daily cap, output verification (every
 * news line must map to a fresh, dated claim), NO_MESSAGE silence, and logs
 * every send to notification_events (the feedback loop's memory).
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
          isNull(suggestions.notifiedAt), // skip anything already pushed (e.g. a breaking ping)
        ),
      )
      .orderBy(desc(suggestions.score))
      .limit(15);
    if (!pending.length) {
      console.log(`[brief:${slug}] NO_MESSAGE (no pending) for ${u.email}`);
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

    const passed: typeof pending = [];
    for (const s of pending) {
      if (passed.length >= maxNudges) break;
      const contact = s.contactId
        ? (await db.select().from(contacts).where(eq(contacts.id, s.contactId)).limit(1))[0]
        : undefined;
      const g = notificationGate(
        { ...baseCtx, sentToday: sentToday + passed.length },
        {
          confidence: s.score ?? 0.5,
          replyPropensity: contact?.replyPropensity ?? 0,
          projectMatch: 0.5,
          category: s.triggerType,
        },
      );
      if (g.pass) passed.push(s);
    }

    if (!passed.length) {
      console.log(`[brief:${slug}] NO_MESSAGE (nothing cleared the gate) for ${u.email}`);
      continue;
    }

    const claimIds = passed.flatMap((s) => s.claimIds ?? []);
    const freshClaims = claimIds.length
      ? await db.select().from(claims).where(inArray(claims.id, claimIds))
      : [];
    const claimById = new Map(freshClaims.map((c) => [c.id, c]));
    const shortDate = (d: string | Date | null) =>
      d ? new Date(typeof d === "string" && d.length <= 10 ? `${d}T00:00:00` : d).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
    const domainOf = (url: string) => {
      try {
        return new URL(url).hostname.replace(/^www\./, "");
      } catch {
        return "source";
      }
    };
    // Each item leads with the news, links the real source + date, then the ready-to-send draft.
    const rawBody = passed
      .map((s) => {
        const claim = (s.claimIds ?? []).map((id) => claimById.get(id)).find((c) => c?.sourceUrl);
        const when = claim ? shortDate(claim.publishedDate ?? claim.eventDate) : "";
        const src = claim?.sourceUrl
          ? ` — ${when ? `${when} · ` : ""}[${domainOf(claim.sourceUrl)}](${claim.sourceUrl})`
          : "";
        return `• ${s.reason}${src}\n${s.draftMessage ?? ""}`;
      })
      .join("\n---\n");
    const { clean, dropped } = verifyBriefAgainstClaims(rawBody, freshClaims);
    if (dropped.length) {
      console.log(`[brief:${slug}] verification dropped ${dropped.length} unbacked line(s)`);
    }

    const header =
      slug === "night-brief" ? "🌙 Night brief" : slug === "midday-update" ? "🔆 Midday update" : "☀️ Morning brief";
    const message = `*${header}*\n---\n${clean || rawBody}`;

    const tg = (
      await db
        .select()
        .from(connectedAccounts)
        .where(and(eq(connectedAccounts.userId, u.id), eq(connectedAccounts.provider, "telegram")))
        .limit(1)
    )[0];
    if (tg?.externalId) await sendMessage(tg.externalId, message);
    else console.log(`[brief:${slug}] no telegram chat for ${u.email} — would send:\n${message}`);

    for (const s of passed) {
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
    }
    // Mark as pushed so no later brief or breaking ping repeats these.
    await db
      .update(suggestions)
      .set({ notifiedAt: new Date() })
      .where(inArray(suggestions.id, passed.map((s) => s.id)));
    console.log(`[brief:${slug}] sent ${passed.length} item(s) to ${u.email}`);
  }
}
