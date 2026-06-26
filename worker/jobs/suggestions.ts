import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { claims, contacts, suggestions, userContext } from "@/db/schema";
import { cadenceForRelevance } from "@/lib/scoring/relevance";
import { isNews } from "@/lib/provenance/claims";
import { mentionsContact } from "@/lib/match/entity";
import { complete } from "@/lib/llm";
import { TONE_GUIDE, stripEmDashes } from "@/lib/agent/tone";
import { getWritingStyleFor } from "@/lib/agent/style";

const TRIGGER_WEIGHT = { re_engage: 0.6, job_change: 0.9, milestone: 0.8 } as const;

/**
 * Proactively open never-messaged but high-relevance imports with a first, no-agenda
 * hello. lastContactedAt is populated ONLY from synced two-way comms, so a large share of
 * a real network legitimately has none — those contacts would otherwise never surface.
 * Bounded per run so the queue (and cost) stays sane; the brief still delivers ~3/day.
 */
const COLD_FIRST_TOUCH_FLOOR = 45;
const MAX_COLD_FIRST_TOUCH_PER_RUN = 30;

/** Detects placeholder/meta leaks like "[recent news]" or "Note: ... rewrite it". */
function hasLeak(s: string): boolean {
  return /\[[^\]]*\]/.test(s) || /(^|\s)note:/i.test(s) || /\bneeded\b/i.test(s) || /rewrite it/i.test(s);
}

/** Draft a short, friendly outreach note AS the user, in their learned voice. */
async function draft(opts: {
  name: string;
  trigger: string;
  focus?: string | null;
  style?: string | null;
  fact?: string;
}): Promise<string> {
  const msg = await complete({
    tier: "strong",
    system:
      "You write outreach AS THE USER (first person), to someone they ALREADY KNOW. " +
      TONE_GUIDE +
      " Use the recipient's real first name. Reference the concrete detail if given; if not, a genuine friendly hello with no invented specifics. Never invent facts. Output ONLY the message text." +
      (opts.style
        ? `\n\nKeep the short text-message format above, but write in the user's own voice, their word choice, warmth, and characteristic phrasing (ignore any email greetings or sign-offs from this profile):\n${opts.style}`
        : ""),
    messages: [
      {
        role: "user",
        content:
          `Recipient: ${opts.name}\nReason: ${opts.trigger}` +
          (opts.fact ? `\nConcrete detail: ${opts.fact}` : "") +
          (opts.focus ? `\nMy current focus: ${opts.focus}` : ""),
      },
    ],
    maxTokens: 160,
    temperature: 0.6,
  });

  if (msg && msg.length > 0 && !msg.startsWith("[llm-stub") && !hasLeak(msg)) return stripEmDashes(msg);

  const first = opts.name.split(/\s+/)[0] || "there";
  if (opts.fact) {
    return stripEmDashes(
      `${first}, congrats on the news! Just saw it and had to say something. We gotta catch up soon, want to hear how it's going.`,
    );
  }
  return stripEmDashes(
    `${first}, it's been way too long! No agenda, you just came to mind. Free to catch up soon?`,
  );
}

async function alreadyPending(userId: string, contactId: string, trigger: string): Promise<boolean> {
  const existing = await db
    .select({ id: suggestions.id })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.userId, userId),
        eq(suggestions.contactId, contactId),
        eq(suggestions.triggerType, trigger as "re_engage" | "job_change" | "milestone"),
        eq(suggestions.status, "pending"),
      ),
    )
    .limit(1);
  return existing.length > 0;
}

function priorityOf(score: number): "high" | "medium" | "low" {
  return score > 0.6 ? "high" : score > 0.4 ? "medium" : "low";
}

/**
 * The proactive engine. For each contact it opens, at most:
 *   • a re-engage (rekindle) draft when they've gone past their check-in cadence, and
 *   • a news / job-change draft from a FRESH, DATED, sourced claim.
 * Each is a personal note written in the user's voice, queued for approval.
 */
export async function runSuggestions(): Promise<void> {
  const all = await db.select().from(contacts);
  // Best-first, so the per-run cold-outreach cap queues your highest-relevance contacts.
  all.sort((a, b) => (b.relevance ?? -1) - (a.relevance ?? -1));
  const ctxCache = new Map<string, { focus: string | null; style: string | null }>();
  let created = 0;
  let coldCreated = 0;

  // Heal: a milestone suggestion must point to a live, sourced claim. Dismiss any whose
  // claims no longer exist (e.g. orphaned by an earlier purge) so we never show a "Why now"
  // with no source; the loop below re-creates a properly-linked one if the news is still fresh.
  const pendingMilestones = await db
    .select({ id: suggestions.id, claimIds: suggestions.claimIds })
    .from(suggestions)
    .where(and(eq(suggestions.status, "pending"), eq(suggestions.triggerType, "milestone")));
  for (const s of pendingMilestones) {
    const ids = s.claimIds ?? [];
    const live = ids.length
      ? (await db.select({ id: claims.id }).from(claims).where(inArray(claims.id, ids))).length
      : 0;
    if (live === 0) {
      await db
        .update(suggestions)
        .set({ status: "dismissed", updatedAt: new Date() })
        .where(eq(suggestions.id, s.id));
    }
  }

  for (const c of all) {
    if (c.isOrganization) continue;

    let cx = ctxCache.get(c.userId);
    if (!cx) {
      const row = (
        await db.select().from(userContext).where(eq(userContext.userId, c.userId)).limit(1)
      )[0];
      // Check-in drafts use the voice Dexa learned for casual catch-ups specifically.
      cx = { focus: row?.currentFocus ?? null, style: await getWritingStyleFor(c.userId, "catch_up") };
      ctxCache.set(c.userId, cx);
    }

    const cadence = cadenceForRelevance(c.relevance ?? null);
    const lastDays = c.lastContactedAt
      ? Math.floor((Date.now() - new Date(c.lastContactedAt).getTime()) / 86_400_000)
      : null;

    // --- Rekindle: keep a real relationship warm, OR open a high-relevance import we've
    // never messaged. lastContactedAt comes only from SYNCED two-way comms, so plenty of
    // genuine contacts have none — those still deserve a first, no-agenda hello. ---
    if (!(await alreadyPending(c.userId, c.id, "re_engage"))) {
      const rel = c.relevance ?? 0;
      const warm = lastDays !== null && lastDays > cadence && rel >= 30;
      const cold =
        lastDays === null &&
        rel >= COLD_FIRST_TOUCH_FLOOR &&
        coldCreated < MAX_COLD_FIRST_TOUCH_PER_RUN &&
        Boolean(c.company || c.role);
      if (warm || cold) {
        const score = warm
          ? Math.min(1, (rel / 100) * TRIGGER_WEIGHT.re_engage + 0.1)
          : Math.min(1, (rel / 100) * TRIGGER_WEIGHT.re_engage);
        const message = await draft({
          name: c.name,
          trigger: warm
            ? `You have not connected in ${lastDays} days; reconnect to keep the relationship warm.`
            : `You know them but have no recorded outreach yet; open with a warm, no-agenda hello.`,
          focus: cx.focus,
          style: cx.style,
        });
        await db.insert(suggestions).values({
          userId: c.userId,
          contactId: c.id,
          triggerType: "re_engage",
          reason: warm
            ? `No touchpoint with ${c.name} in ${lastDays} days.`
            : `${c.name} is a high-relevance contact you haven't reached out to yet.`,
          draftMessage: message,
          intentLabel: warm ? "Reconnect with a check-in" : "Open the relationship",
          priority: priorityOf(score),
          score,
          claimIds: [],
        });
        created++;
        if (cold) coldCreated++;
      }
    }

    // --- News / job-change: a fresh, dated, sourced moment ---
    const cl = await db.select().from(claims).where(eq(claims.contactId, c.id));
    const fresh = cl
      .filter((x) => isNews(x))
      // Web 'news' claims must verifiably reference this contact's firm/name — drops
      // mismatched items (e.g. an "Ion Video" article stored against an "Ion Pacific"
      // contact). job_change (LinkedIn) and x_post (verified handle) are trusted.
      .filter((x) => x.field !== "news" || mentionsContact(c, `${x.value} ${x.sourceUrl ?? ""}`));
    if (fresh.length) {
      const chosen =
        fresh.find((x) => x.field === "job_change") ??
        fresh.find((x) => x.field === "news") ??
        fresh.find((x) => x.field === "x_post");
      if (chosen) {
        const trigger = chosen.field === "job_change" ? "job_change" : "milestone";
        if (!(await alreadyPending(c.userId, c.id, trigger))) {
          const weight = trigger === "job_change" ? TRIGGER_WEIGHT.job_change : TRIGGER_WEIGHT.milestone;
          // Newer updates rank above stale ones in the digest.
          const ageDays = chosen.eventDate
            ? (Date.now() - new Date(chosen.eventDate).getTime()) / 86_400_000
            : 99;
          const recencyBoost = ageDays <= 2 ? 0.1 : ageDays <= 7 ? 0.05 : 0;
          const score = Math.min(1, ((c.relevance ?? 0) / 100) * weight + 0.15 + recencyBoost);
          const message = await draft({
            name: c.name,
            trigger:
              trigger === "job_change"
                ? "They recently changed roles; congratulate them warmly."
                : chosen.field === "x_post"
                  ? "They just posted something notable on X; react to it naturally."
                  : "Something noteworthy just happened for them; acknowledge it.",
            fact: chosen.value,
            focus: cx.focus,
            style: cx.style,
          });
          await db.insert(suggestions).values({
            userId: c.userId,
            contactId: c.id,
            triggerType: trigger,
            reason: `${c.name}: ${chosen.value}`,
            draftMessage: message,
            intentLabel:
              trigger === "job_change"
                ? "Congratulate on the move"
                : chosen.field === "x_post"
                  ? "React to their X post"
                  : "Acknowledge recent news",
            priority: priorityOf(score),
            score,
            claimIds: fresh.map((f) => f.id),
          });
          created++;
        }
      }
    }
  }
  console.log(`[suggestions] created ${created} suggestions`);
}
