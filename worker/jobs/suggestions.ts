import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { claims, contacts, suggestions, userContext } from "@/db/schema";
import { cadenceForRelevance } from "@/lib/scoring/relevance";
import { isNews } from "@/lib/provenance/claims";
import { complete } from "@/lib/llm";

const TRIGGER_WEIGHT = { re_engage: 0.6, job_change: 0.9, milestone: 0.8 } as const;

async function draftMessage(name: string, reason: string, focus: string | undefined): Promise<string> {
  return complete({
    tier: "strong",
    system:
      "You write short, warm, specific outreach for a relationship-first dealmaker. " +
      "Reference something concrete about the RECIPIENT, never lead with an ask. " +
      "2-3 sentences. No subject line. Never include meta-commentary about yourself.",
    messages: [
      {
        role: "user",
        content: `Recipient: ${name}\nWhy now: ${reason}\nMy current focus: ${focus ?? "n/a"}\nWrite the message.`,
      },
    ],
    maxTokens: 220,
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

/** Generate suggestions from re-engage cadence and FRESH dated milestone claims. */
export async function runSuggestions(): Promise<void> {
  const all = await db.select().from(contacts);
  let created = 0;

  for (const c of all) {
    if (c.isOrganization) continue;
    const ctx = (
      await db.select().from(userContext).where(eq(userContext.userId, c.userId)).limit(1)
    )[0];
    const focus = ctx?.currentFocus ?? undefined;
    const cadence = cadenceForRelevance(c.relevance ?? null);
    const lastDays = c.lastContactedAt
      ? Math.floor((Date.now() - new Date(c.lastContactedAt).getTime()) / 86_400_000)
      : null;

    if (lastDays !== null && lastDays > cadence && (c.relevance ?? 0) >= 30) {
      if (!(await alreadyPending(c.userId, c.id, "re_engage"))) {
        const reason = `No touchpoint with ${c.name} in ${lastDays} days (their relevance suggests checking in after ${cadence}).`;
        const score = Math.min(1, ((c.relevance ?? 0) / 100) * TRIGGER_WEIGHT.re_engage + 0.1);
        await db.insert(suggestions).values({
          userId: c.userId,
          contactId: c.id,
          triggerType: "re_engage",
          reason,
          draftMessage: await draftMessage(c.name, reason, focus),
          intentLabel: "Reconnect with a check-in",
          priority: score > 0.6 ? "high" : score > 0.4 ? "medium" : "low",
          score,
          claimIds: [],
        });
        created++;
      }
    }

    const cl = await db.select().from(claims).where(eq(claims.contactId, c.id));
    const fresh = cl.filter((x) => isNews(x));
    if (fresh.length && !(await alreadyPending(c.userId, c.id, "milestone"))) {
      const reason = `${c.name}: ${fresh[0].value}`;
      const score = Math.min(1, ((c.relevance ?? 0) / 100) * TRIGGER_WEIGHT.milestone + 0.1);
      await db.insert(suggestions).values({
        userId: c.userId,
        contactId: c.id,
        triggerType: "milestone",
        reason,
        draftMessage: await draftMessage(c.name, reason, focus),
        intentLabel: "Acknowledge recent milestone",
        priority: score > 0.6 ? "high" : score > 0.4 ? "medium" : "low",
        score,
        claimIds: fresh.map((f) => f.id),
      });
      created++;
    }
  }
  console.log(`[suggestions] created ${created} suggestions`);
}
