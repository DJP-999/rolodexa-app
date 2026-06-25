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

// The situations Dexa learns a distinct voice for. Closed set so classification stays consistent.
export const SITUATIONS = [
  "reschedule", // rescheduling / missed-meeting follow-ups
  "deal_share", // sending deals, decks, opportunities
  "catch_up", // casual check-ins, keeping warm
  "intro", // introductions / connecting people
  "follow_up", // post-meeting next steps
  "scheduling", // setting up a meeting
  "ask", // making a request
  "thanks", // gratitude / thank-yous
  "general",
] as const;
export type Situation = (typeof SITUATIONS)[number];

/**
 * The best voice guide for a given situation: the situation-specific guide if Dexa has
 * learned one, otherwise the global voice. Drafters pass the situation they're writing for.
 */
export async function getWritingStyleFor(userId: string, situation?: string | null): Promise<string | null> {
  const c = (
    await db
      .select({ s: userContext.writingStyle, by: userContext.writingStyleBySituation })
      .from(userContext)
      .where(eq(userContext.userId, userId))
      .limit(1)
  )[0];
  const by = (c?.by ?? {}) as Record<string, string>;
  if (situation && by[situation]?.trim()) return by[situation];
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

/** Sent messages with their subject, newest first, for situation-aware learning. */
async function richSamples(userId: string): Promise<{ subject: string; text: string }[]> {
  const rows = await db
    .select({ metadata: interactions.metadata })
    .from(interactions)
    .where(and(eq(interactions.userId, userId), eq(interactions.direction, "outbound"), isNotNull(interactions.metadata)))
    .orderBy(desc(interactions.occurredAt))
    .limit(300);
  const seen = new Set<string>();
  const out: { subject: string; text: string }[] = [];
  for (const r of rows) {
    const m = r.metadata as { subject?: string; text?: string } | null;
    const text = typeof m?.text === "string" ? m.text.trim() : "";
    if (text.length < 25) continue;
    const key = text.slice(0, 60).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ subject: typeof m?.subject === "string" ? m.subject : "", text });
    if (out.length >= 60) break;
  }
  return out;
}

/**
 * Learn a distinct voice per SITUATION (reschedule, deal_share, catch_up, …) from the
 * user's sent messages, so each kind of outreach sounds like how they actually write it.
 * Additive to the global voice; skipped when the user has pinned a manual override.
 */
export async function deriveWritingStyleBySituation(userId: string): Promise<void> {
  const row = (
    await db
      .select({ source: userContext.writingStyleSource, by: userContext.writingStyleBySituation })
      .from(userContext)
      .where(eq(userContext.userId, userId))
      .limit(1)
  )[0];
  if (row?.source === "manual") return; // their pinned voice wins everywhere

  const samples = await richSamples(userId);
  if (samples.length < 6) return;

  // 1) Classify each sample into a situation (one cheap call).
  const list = samples.map((s, i) => `${i + 1}. [subject: ${s.subject || "—"}] ${s.text.slice(0, 300)}`).join("\n");
  const clsRaw = await complete({
    tier: "cheap",
    system:
      "Classify each sent message into ONE situation from this exact set: " +
      SITUATIONS.join(", ") +
      ". reschedule = rescheduling or missed-meeting notes; deal_share = sending a deal/opportunity/deck; " +
      "catch_up = casual check-in; intro = introducing people; follow_up = post-meeting next steps; " +
      "scheduling = setting up a meeting; ask = a request; thanks = gratitude; general = anything else. " +
      'Return STRICT JSON array, one object per message: [{"i":1,"s":"catch_up"}, …]. No prose.',
    messages: [{ role: "user", content: list }],
    maxTokens: 800,
    temperature: 0,
  });
  let labels: { i: number; s: string }[] = [];
  try {
    const m = clsRaw.match(/\[[\s\S]*\]/);
    if (m) labels = JSON.parse(m[0]);
  } catch {
    return;
  }
  const groups = new Map<string, string[]>();
  for (const { i, s } of labels) {
    const sample = samples[i - 1];
    if (!sample || !SITUATIONS.includes(s as Situation)) continue;
    (groups.get(s) ?? groups.set(s, []).get(s)!).push(sample.text);
  }
  // Only learn situations with enough signal.
  const learnable = [...groups.entries()].filter(([, arr]) => arr.length >= 3);
  if (!learnable.length) return;

  // 2) Derive a short voice guide for each qualifying situation (one call).
  const blocks = learnable
    .map(([sit, arr]) => `### ${sit}\n` + arr.slice(0, 10).map((t, i) => `${i + 1}. ${t.slice(0, 400)}`).join("\n"))
    .join("\n\n");
  const guideRaw = await complete({
    tier: "cheap",
    system:
      "For each situation below, write a concise VOICE GUIDE (under 90 words each) capturing how THIS person writes that kind of message: tone, opener style, characteristic phrases, sign-off habit, length, formality, emoji use. Use only the samples. " +
      'Return STRICT JSON object mapping situation → guide string, e.g. {"reschedule":"…","catch_up":"…"}. No prose outside JSON.',
    messages: [{ role: "user", content: blocks }],
    maxTokens: 1200,
    temperature: 0.2,
  });
  let guides: Record<string, string> = {};
  try {
    const m = guideRaw.match(/\{[\s\S]*\}/);
    if (m) guides = JSON.parse(m[0]);
  } catch {
    return;
  }
  const merged = { ...((row?.by ?? {}) as Record<string, string>) };
  for (const [sit, g] of Object.entries(guides)) {
    if (SITUATIONS.includes(sit as Situation) && typeof g === "string" && g.trim()) merged[sit] = g.trim().slice(0, 800);
  }
  if (Object.keys(merged).length) {
    await db.update(userContext).set({ writingStyleBySituation: merged, updatedAt: new Date() }).where(eq(userContext.userId, userId));
    console.log(`[style] learned ${Object.keys(guides).length} situational voice(s) for ${userId}`);
  }
}
