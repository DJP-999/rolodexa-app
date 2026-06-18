/**
 * Relevance grade (0..100) = normalized weighted sum of per-dimension signals.
 * Reply-propensity is a first-class dimension, so importance reflects behavior.
 */
export type Weights = {
  professional: number;
  recency: number;
  relationship: number;
  geographic: number;
  trigger: number;
  replyPropensity: number;
};

export type Signals = {
  professional: number;
  recency: number;
  relationship: number;
  geographic: number;
  trigger: number;
  replyPropensity: number;
};

export function normalizeWeights(w: Weights): Weights {
  const sum =
    w.professional + w.recency + w.relationship + w.geographic + w.trigger + w.replyPropensity || 1;
  return {
    professional: w.professional / sum,
    recency: w.recency / sum,
    relationship: w.relationship / sum,
    geographic: w.geographic / sum,
    trigger: w.trigger / sum,
    replyPropensity: w.replyPropensity / sum,
  };
}

export function computeRelevance(weights: Weights, s: Signals): number {
  const w = normalizeWeights(weights);
  const score =
    w.professional * s.professional +
    w.recency * s.recency +
    w.relationship * s.relationship +
    w.geographic * s.geographic +
    w.trigger * s.trigger +
    w.replyPropensity * s.replyPropensity;
  return Math.round(Math.max(0, Math.min(1, score)) * 100);
}

/** Recency signal: exponential decay vs a relevance-scaled cadence. */
export function recencySignal(lastDays: number | null, cadenceDays = 30): number {
  if (lastDays === null) return 0.2;
  return Number(Math.exp(-lastDays / Math.max(1, cadenceDays)).toFixed(4));
}

/** Higher-relevance contacts get a shorter check-in cadence (21d→45d). */
export function cadenceForRelevance(relevance: number | null): number {
  if (relevance === null) return 45;
  if (relevance >= 75) return 21;
  if (relevance >= 50) return 30;
  return 45;
}
