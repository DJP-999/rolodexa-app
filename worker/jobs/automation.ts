import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { automations, connectedAccounts } from "@/db/schema";
import { buildAgentContext } from "@/lib/agent/context";
import { complete } from "@/lib/llm";
import { sendMessage } from "@/lib/integrations/telegram";

/**
 * Run one user-defined automation: feed its prompt to the agent with real network
 * context, then deliver the result over Telegram. Stays silent on NO_MESSAGE so a
 * recurring automation never sends noise.
 */
export async function runAutomation(id: string): Promise<void> {
  const a = (await db.select().from(automations).where(eq(automations.id, id)).limit(1))[0];
  if (!a || !a.enabled) return;

  const context = await buildAgentContext(a.userId, a.prompt);
  const reply = await complete({
    tier: "strong",
    system:
      "You are Dexa, a relationship & deal-flow co-pilot running a scheduled automation for the user. " +
      "Use ONLY the CONTEXT for facts about specific people; never invent. Be concise, specific, and actionable. " +
      "If nothing is worth sending right now, reply with exactly NO_MESSAGE.\n\n=== CONTEXT ===\n" +
      context,
    messages: [{ role: "user", content: a.prompt }],
    maxTokens: 900,
  });

  let status = "silent (NO_MESSAGE)";
  if (reply.trim() && !/^\s*NO_MESSAGE/i.test(reply)) {
    const tg = (
      await db
        .select()
        .from(connectedAccounts)
        .where(and(eq(connectedAccounts.userId, a.userId), eq(connectedAccounts.provider, "telegram")))
        .limit(1)
    )[0];
    if (tg?.externalId) {
      await sendMessage(tg.externalId, `*${a.name}*\n---\n${reply}`);
      status = "delivered:telegram";
    } else {
      status = "no-telegram";
    }
  }

  await db
    .update(automations)
    .set({ lastRunAt: new Date(), lastRunStatus: status })
    .where(eq(automations.id, id));
}
