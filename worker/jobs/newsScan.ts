import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  claims,
  connectedAccounts,
  contacts,
  notificationEvents,
  suggestions,
  userContext,
} from "@/db/schema";
import {
  notificationGate,
  deriveSuppressedCategories,
  type GateContext,
} from "@/lib/notifications/gate";
import { sendMessage } from "@/lib/integrations/telegram";
import { resolveChannel } from "@/lib/outreach/deliver";
import { webNewsPass, xNewsPass } from "./enrichment";
import { runSuggestions } from "./suggestions";

const NEWS_SCAN_WINDOW_DAYS = 3; // intraday scan only cares about the last few days
const NEWS_SCAN_TOP_N = 10; // keep cost bounded: only your most important relationships
const BREAKING_DAILY_CAP = 2; // a breaking ping must be rare to stay worth opening
const BREAKING_MIN_SCORE = 0.62;
const FRESH_HOURS = 12; // only ping on genuinely new items

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

/**
 * Intraday "keep up with the network" pass for top relationships: pull fresh web + X
 * signals, turn them into suggestions, then push a BREAKING Telegram ping for the rare
 * brand-new, high-relevance item, so the rest waits for the next digest.
 */
export async function runNewsScan(): Promise<void> {
  const all = await db.select().from(contacts);
  if (!all.length) return;

  const byUser = new Map<string, typeof all>();
  for (const c of all) {
    const l = byUser.get(c.userId) ?? [];
    l.push(c);
    byUser.set(c.userId, l);
  }

  // 1) Gather fresh signals for each user's top contacts. Claims are idempotent
  // (stable ids) and validated at creation, so we re-derive without wiping — that keeps
  // every suggestion's cited source intact instead of orphaning it on each scan.
  for (const [, list] of byUser) {
    const top = list
      .filter((c) => !c.isOrganization && ((c.relevance ?? 0) >= 60 || c.highValue))
      .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
      .slice(0, NEWS_SCAN_TOP_N);
    if (!top.length) continue;
    await webNewsPass(top, NEWS_SCAN_WINDOW_DAYS, top.length);
    await xNewsPass(top, NEWS_SCAN_WINDOW_DAYS, top.length);
  }

  // 2) Convert any new claims into ranked suggestions (deduped inside).
  await runSuggestions();

  // 3) Breaking pings for the rare must-know item.
  for (const [userId] of byUser) {
    await pushBreaking(userId);
  }
  console.log("[news-scan] complete");
}

async function pushBreaking(userId: string): Promise<void> {
  const tg = (
    await db
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, "telegram")))
      .limit(1)
  )[0];
  if (!tg?.externalId) return;

  const ctx = (
    await db.select().from(userContext).where(eq(userContext.userId, userId)).limit(1)
  )[0];

  const start = startOfToday();
  const sentTodayRows = await db
    .select({ id: notificationEvents.id })
    .from(notificationEvents)
    .where(
      and(
        eq(notificationEvents.userId, userId),
        gte(notificationEvents.sentAt, start),
        sql`(${notificationEvents.metadata} ->> 'breaking') = 'true'`,
      ),
    );
  let sent = sentTodayRows.length;
  if (sent >= BREAKING_DAILY_CAP) return;

  const recent = await db
    .select({ category: notificationEvents.category, outcome: notificationEvents.outcome })
    .from(notificationEvents)
    .where(
      and(
        eq(notificationEvents.userId, userId),
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
    maxNudgesPerDay: BREAKING_DAILY_CAP,
    suppressedCategories: suppressed,
  };

  const since = new Date(Date.now() - FRESH_HOURS * 3_600_000);
  const cands = await db
    .select()
    .from(suggestions)
    .where(
      and(
        eq(suggestions.userId, userId),
        eq(suggestions.status, "pending"),
        isNull(suggestions.notifiedAt),
        inArray(suggestions.triggerType, ["job_change", "milestone"]),
        gte(suggestions.createdAt, since),
      ),
    )
    .orderBy(desc(suggestions.score))
    .limit(10);

  for (const s of cands) {
    if (sent >= BREAKING_DAILY_CAP) break;
    if ((s.score ?? 0) < BREAKING_MIN_SCORE) continue;
    if (!(s.claimIds && s.claimIds.length)) continue; // must be a sourced moment
    const contact = s.contactId
      ? (await db.select().from(contacts).where(eq(contacts.id, s.contactId)).limit(1))[0]
      : undefined;
    if (!contact) continue;
    if (!(contact.highValue || (contact.relevance ?? 0) >= 70)) continue;

    const g = notificationGate(
      { ...baseCtx, sentToday: sent },
      {
        confidence: s.score ?? 0.5,
        replyPropensity: contact.replyPropensity ?? 0,
        projectMatch: 0.5,
        category: s.triggerType,
        highValue: contact.highValue ?? false,
      },
    );
    if (!g.pass) continue;

    const claim = (
      await db.select().from(claims).where(inArray(claims.id, s.claimIds)).limit(5)
    ).find((c) => c.sourceUrl);
    const src = claim?.sourceUrl ? `\n${claim.sourceUrl}` : "";
    const channel = await resolveChannel(contact);
    const via =
      channel === "linkedin"
        ? "Approve → sends as a LinkedIn DM"
        : channel === "email"
          ? "Approve → sends via email"
          : "No channel on file — open in app to send";
    const message = `⚡ Heads up — ${contact.name}\n${s.reason}${src}\n\n${s.draftMessage ?? ""}\n\n${via}`;

    const ok = await sendMessage(
      tg.externalId,
      message,
      [
        { label: "✅ Approve & send", data: `approve:${s.id}` },
        { label: "✏️ Edit", data: `edit:${s.id}` },
        { label: "✕ Decline", data: `decline:${s.id}` },
      ],
      { plain: true },
    );
    if (!ok) continue;

    await db.update(suggestions).set({ notifiedAt: new Date() }).where(eq(suggestions.id, s.id));
    await db.insert(notificationEvents).values({
      userId,
      suggestionId: s.id,
      contactId: s.contactId ?? null,
      triggerType: s.triggerType,
      category: s.triggerType,
      channel: "telegram",
      sentAt: new Date(),
      outcome: "sent",
      metadata: { breaking: true },
    });
    sent++;
  }
  if (sent) console.log(`[news-scan] ${sent} breaking ping(s) to user ${userId}`);
}
