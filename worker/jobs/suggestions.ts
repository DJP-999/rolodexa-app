import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { claims, contacts, suggestions, userContext } from "@/db/schema";
import { cadenceForRelevance } from "@/lib/scoring/relevance";
import { isNews } from "@/lib/provenance/claims";
import { complete } from "@/lib/llm";

const TRIGGER_WEIGHT = { re_engage: 0.6, job_change: 0.9, milestone: 0.8 } as const;

/** Draft a short outreach note AS the user, in their learned voice. */
async function draft(opts: {
  name: string;
  reason: string;
  focus?: string | null;
  style?: string | null;
  fact?: string;
}): Promise<string> {
  return complete({
    tier: "strong",
    system:
      "You write outreach AS THE USER (first person), to be sent from their own account to a contact. " +
      "Match the user's writing style if one is provided. Keep it SHORT — 2 to 4 sentences. Warm, specific, human. " +
      "Open by referencing the concrete reason; never lead with an ask. Use the recipient's real first name. " +
      "No subject line, no placeholders, no meta-commentary about yourself. Never invent facts beyond what is given. " +
      "Output only the message text." +
      (opts.style ? `\n\nUSER WRITING STYLE:\n${opts.style}` : ""),
    messages: [
      {
        role: "user",
        content:
          `Recipient: ${opts.name}\nWhy I'm reaching out: ${opts.reason}` +
          (opts.fact ? `\nConcrete detail to reference: ${opts.fact}` : "") +
          (opts.focus ? `\nMy current focus (mention only if it fits naturally): ${opts.focus}` : ""),
      },
    ],
    maxTokens: 220,
    temperature: 0.6,
  });
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
        await db.insert(suggestions).values({
          userId: c.userId,
          contactId: c.id,
          triggerType: "re_engage",
          reason: `No touchpoint with ${c.name} in ${lastDays} days — worth a genuine check-in.`,
          draftMessage: await draft({
            name: c.name,
            reason: `It's been about ${lastDays} days since we last connected; I want to check in and keep the relationship warm — no agenda.`,
            focus: cx.focus,
            style: cx.style,
          }),
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
          await db.insert(suggestions).values({
            userId: c.userId,
            contactId: c.id,
            triggerType: trigger,
            reason: `${c.name}: ${chosen.value}`,
            draftMessage: await draft({
              name: c.name,
              reason:
                trigger === "job_change"
                  ? "They recently changed roles — a quick, warm congratulations."
                  : "Something noteworthy just happened for them — a brief, genuine acknowledgement.",
              fact: chosen.value,
              focus: cx.focus,
              style: cx.style,
            }),
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
