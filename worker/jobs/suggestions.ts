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

/**
 * Generate the "why this, why now" rationale AND the outreach message in one call.
 * Rationale is for the user's eyes; the message is the friendly note to send.
 */
async function generateOutreach(opts: {
  name: string;
  trigger: string;
  focus?: string | null;
  style?: string | null;
  fact?: string;
}): Promise<{ rationale: string; message: string }> {
  const raw = await complete({
    tier: "strong",
    system:
      "You help a dealmaker reach out to someone they ALREADY KNOW. Return JSON with two fields:\n" +
      '"rationale": 1-2 sentences for the user\'s eyes only, explaining why reach out to this person and why now.\n' +
      '"message": the actual note to send, first person, as the user.\n' +
      "For the message: " +
      TONE_GUIDE +
      " Use the recipient's real first name. Reference the concrete detail if given; if not, a genuine friendly hello with no invented specifics. Never invent facts. " +
      'Return ONLY JSON: {"rationale":"...","message":"..."}.' +
      (opts.style ? `\n\nMatch how the user writes:\n${opts.style}` : ""),
    messages: [
      {
        role: "user",
        content:
          `Recipient: ${opts.name}\nTrigger: ${opts.trigger}` +
          (opts.fact ? `\nConcrete detail: ${opts.fact}` : "") +
          (opts.focus ? `\nMy current focus: ${opts.focus}` : ""),
      },
    ],
    maxTokens: 360,
    temperature: 0.6,
  });

  try {
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    const message = typeof obj.message === "string" ? obj.message.trim() : "";
    const rationale = typeof obj.rationale === "string" ? obj.rationale.trim() : "";
    if (message && !hasLeak(message)) {
      return { rationale: stripEmDashes(rationale), message: stripEmDashes(message) };
    }
  } catch {
    /* fall through to the deterministic fallback */
  }

  const first = opts.name.split(/\s+/)[0] || "there";
  if (opts.fact) {
    return {
      rationale: "They just had a notable update, so it is a natural, timely reason to reconnect.",
      message: stripEmDashes(
        `Hey ${first}, congrats on the news, saw it and had to reach out. Let's catch up once things settle, would love to hear how it is going.`,
      ),
    };
  }
  return {
    rationale: "It has been a while since you connected, and this relationship is worth keeping warm.",
    message: stripEmDashes(
      `Hey ${first}, it has been way too long. No agenda, you just came to mind and I wanted to say hi. Free to catch up sometime soon?`,
    ),
  };
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
        const out = await generateOutreach({
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
          rationale: out.rationale,
          draftMessage: out.message,
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
          const out = await generateOutreach({
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
            rationale: out.rationale,
            draftMessage: out.message,
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
