import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { interactions, userContext } from "@/db/schema";
import { complete } from "@/lib/llm";

export async function getWritingStyle(userId: string): Promise<string | null> {
  const c = (
    await db
      .select({ s: userContext.writingStyle })
      .from(userContext)
      .where(eq(userContext.userId, userId))
      .limit(1)
  )[0];
  return c?.s ?? null;
}

/**
 * Learn the user's outreach voice from their own sent messages so proactive drafts
 * sound like them. Only fills when empty, so a hand-edited style in Settings is
 * never clobbered. Needs a few real outbound samples to say anything.
 */
export async function deriveWritingStyle(userId: string): Promise<void> {
  const existing = await getWritingStyle(userId);
  if (existing && existing.trim().length > 0) return;

  const outbound = await db
    .select({ metadata: interactions.metadata })
    .from(interactions)
    .where(and(eq(interactions.userId, userId), eq(interactions.direction, "outbound")))
    .orderBy(desc(interactions.occurredAt))
    .limit(50);

  const samples = outbound
    .map((r) => {
      const m = r.metadata as { text?: string } | null;
      return typeof m?.text === "string" ? m.text : "";
    })
    .filter((t) => t && t.length > 20)
    .slice(0, 25);

  if (samples.length < 3) return;

  const style = await complete({
    tier: "cheap",
    system:
      "You analyze a person's outbound messages and produce a concise, reusable WRITING STYLE GUIDE another writer can follow to imitate their voice. " +
      "Cover: typical length, greeting and sign-off, tone/formality, sentence rhythm, punctuation and emoji habits, and 2-3 characteristic phrases. " +
      "Be specific and under 150 words. Do not quote whole messages.",
    messages: [
      {
        role: "user",
        content: "My sent messages:\n\n" + samples.map((s, i) => `${i + 1}. ${s}`).join("\n"),
      },
    ],
    maxTokens: 400,
    temperature: 0.2,
  });

  if (style && !style.startsWith("[llm-stub")) {
    await db
      .insert(userContext)
      .values({ userId, writingStyle: style })
      .onConflictDoUpdate({
        target: userContext.userId,
        set: { writingStyle: style, updatedAt: new Date() },
      });
  }
}
