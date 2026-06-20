import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { interactions, userContext } from "@/db/schema";
import { complete } from "@/lib/llm";

/** Re-derive once this many NEW outbound samples have accumulated since the last learn. */
const GROW_THRESHOLD = 8;
/** Most samples to feed the model in one pass (keeps cost bounded on big mailboxes). */
const MAX_SAMPLES = 40;

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

/** Pull the user's own sent prose (LinkedIn DMs + sent emails), newest first. */
async function outboundSamples(userId: string): Promise<string[]> {
  const rows = await db
    .select({ metadata: interactions.metadata })
    .from(interactions)
    .where(
      and(
        eq(interactions.userId, userId),
        eq(interactions.direction, "outbound"),
        isNotNull(interactions.metadata),
      ),
    )
    .orderBy(desc(interactions.occurredAt))
    .limit(200);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const m = r.metadata as { text?: string } | null;
    const t = typeof m?.text === "string" ? m.text.trim() : "";
    if (t.length < 20) continue;
    const key = t.slice(0, 60).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_SAMPLES) break;
  }
  return out;
}

/**
 * Learn (and keep refining) the user's outreach VOICE from their own sent messages, so
 * proactive drafts increasingly sound like them. The default text-message format always
 * wins; this only teaches diction, warmth, characteristic phrases, and emoji habits.
 *
 * Behavior:
 *  - Never overwrites a hand-edited style (source = "manual").
 *  - Re-derives over time, but only once enough NEW samples accumulate (cost-aware).
 *  - Refines the existing guess rather than starting over each time.
 */
export async function deriveWritingStyle(userId: string): Promise<void> {
  const row = (
    await db
      .select({
        style: userContext.writingStyle,
        source: userContext.writingStyleSource,
        learnedFrom: userContext.writingStyleSamples,
      })
      .from(userContext)
      .where(eq(userContext.userId, userId))
      .limit(1)
  )[0];

  // Respect a manual override; the user's explicit voice is the source of truth.
  if (row?.source === "manual" && (row.style?.trim().length ?? 0) > 0) return;

  const samples = await outboundSamples(userId);
  if (samples.length < 3) return;

  const prior = row?.style?.trim() ?? "";
  const learnedFrom = row?.learnedFrom ?? 0;
  // Skip if we already learned from roughly this much data (no meaningful new signal).
  if (prior && samples.length < learnedFrom + GROW_THRESHOLD) return;

  const style = await complete({
    tier: "cheap",
    system:
      "You analyze a person's own sent messages and produce a concise, reusable VOICE GUIDE another writer can follow to sound like them in SHORT, casual messages (texts and DMs). " +
      "Focus on portable voice: tone and warmth, level of casualness, word choice and vocabulary, sentence rhythm, punctuation and emoji habits, and 2 to 3 characteristic words or phrases they actually use. " +
      "Do NOT prescribe email formatting like greetings, salutations, or sign-offs, and do not tell the writer to be formal or long even if some samples are. The drafts are always short texts; you are only teaching their personality and phrasing. " +
      "Be specific and under 140 words. Do not quote whole messages." +
      (prior
        ? "\n\nHere is the current best guess at their voice. Refine and sharpen it using the new samples; keep what still holds, correct what does not:\n" +
          prior
        : ""),
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
      .values({
        userId,
        writingStyle: style,
        writingStyleSource: "auto",
        writingStyleSamples: samples.length,
        writingStyleUpdatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: userContext.userId,
        set: {
          writingStyle: style,
          writingStyleSource: "auto",
          writingStyleSamples: samples.length,
          writingStyleUpdatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    console.log(`[style] learned voice for ${userId} from ${samples.length} samples`);
  }
}
