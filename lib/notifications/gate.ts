/**
 * The single chokepoint every proactive message must pass — what stops the
 * swiping. A notification must clear a confidence bar AND be tied to either
 * someone you engage (reply-propensity) or your active work (project match),
 * never exceed the daily cap, and never fire while observing.
 */
export type GateContext = {
  observationUntil: string | null;
  gateConfidence: number;
  gateReplyPropensity: number;
  gateProjectMatch: number;
  maxNudgesPerDay: number;
  sentToday: number;
  suppressedCategories: Set<string>;
};

export type Candidate = {
  confidence: number;
  replyPropensity: number;
  projectMatch: number;
  category: string;
};

export type GateResult = { pass: true } | { pass: false; reason: string };

export function notificationGate(ctx: GateContext, c: Candidate): GateResult {
  if (ctx.observationUntil && new Date(ctx.observationUntil) > new Date()) {
    return { pass: false, reason: "observation_window" };
  }
  if (ctx.sentToday >= ctx.maxNudgesPerDay) {
    return { pass: false, reason: "daily_cap" };
  }
  if (ctx.suppressedCategories.has(c.category)) {
    return { pass: false, reason: "category_suppressed" };
  }
  if (c.confidence < ctx.gateConfidence) {
    return { pass: false, reason: "below_confidence" };
  }
  const relevantToYou =
    c.replyPropensity >= ctx.gateReplyPropensity || c.projectMatch >= ctx.gateProjectMatch;
  if (!relevantToYou) {
    return { pass: false, reason: "not_relevant_to_you" };
  }
  return { pass: true };
}

/** Mute categories the user keeps dismissing/ignoring. */
export function deriveSuppressedCategories(
  outcomes: { category: string | null; outcome: string }[],
  threshold = 3,
): Set<string> {
  const counts = new Map<string, number>();
  for (const o of outcomes) {
    if (!o.category) continue;
    if (o.outcome === "dismissed" || o.outcome === "ignored") {
      counts.set(o.category, (counts.get(o.category) ?? 0) + 1);
    }
  }
  const suppressed = new Set<string>();
  for (const [cat, n] of counts) if (n >= threshold) suppressed.add(cat);
  return suppressed;
}
