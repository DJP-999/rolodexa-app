import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { claims, contacts, suggestions, userContext } from "@/db/schema";
import { cadenceForRelevance } from "@/lib/scoring/relevance";
import { isNews } from "@/lib/provenance/claims";
import { complete } from "@/lib/llm";
import { TONE_GUIDE, stripEmDashes } from "@/lib/agent/tone";

const TRIGGER_WEIGHT = { re_engage: 0.6, job_change: 0.9, milestone: 0.8 } as const;

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
  const ctxCache = new Map<string, { focus: string | null; style: string | null }>();
  let created = 0;

  for (const c of all) {
    if (c.isOrganization) continue;

    let cx = ctxCache.get(c.userId);
    if (!cx) {
      const row = (
        await db.select().from(userContext).where(eq(userContext.userId, c.userId)).limit(1)
      )[0];
      cx = { focus: row?.currentFocus ?? null, style: row?.writingStyle ?? null };
      ctxCache.set(c.userId, cx);
    }

    const cadence = cadenceForRelevance(c.relevance ?? null);
    const lastDays = c.lastContactedAt
      ? Math.floor((Date.now() - new Date(c.lastContactedAt).getTime()) / 86_400_000)
      : null;

    // --- Rekindle: meaningful relationship gone quiet ---
    if (lastDays !== null && lastDays > cadence && (c.relevance ?? 0) >= 30) {
      if (!(await alreadyPending(c.userId, c.id, "re_engage"))) {
        const score = Math.min(1, ((c.relevance ?? 0) / 100) * TRIGGER_WEIGHT.re_engage + 0.1);
        const message = await draft({
          name: c.name,
          trigger: `You have not connected in ${lastDays} days; reconnect to keep the relationship warm.`,
          focus: cx.focus,
          style: cx.style,
        });
        await db.insert(suggestions).values({
          userId: c.userId,
          contactId: c.id,
          triggerType: "re_engage",
          reason: `No touchpoint with ${c.name} in ${lastDays} days.`,
          draftMessage: message,
          intentLabel: "Reconnect with a check-in",
          priority: priorityOf(score),
          score,
          claimIds: [],
        });
        created++;
      }
    }

    // --- News / job-change: a fresh, dated, sourced moment ---
    const cl = await db.select().from(claims).where(eq(claims.contactId, c.id));
    const fresh = cl.filter((x) => isNews(x));
    if (fresh.length) {
      const chosen = fresh.find((x) => x.field === "job_change") ?? fresh.find((x) => x.field === "news");
      if (chosen) {
        const trigger = chosen.field === "job_change" ? "job_change" : "milestone";
        if (!(await alreadyPending(c.userId, c.id, trigger))) {
          const weight = trigger === "job_change" ? TRIGGER_WEIGHT.job_change : TRIGGER_WEIGHT.milestone;
          const score = Math.min(1, ((c.relevance ?? 0) / 100) * weight + 0.15);
          const message = await draft({
            name: c.name,
            trigger:
              trigger === "job_change"
                ? "They recently changed roles; congratulate them warmly."
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
            intentLabel: trigger === "job_change" ? "Congratulate on the move" : "Acknowledge recent news",
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
