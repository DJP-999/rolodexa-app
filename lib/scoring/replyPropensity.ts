import type { Interaction } from "@/db/schema";

/**
 * Reply-propensity — the learned "do you actually engage this person?" signal.
 * Computed from observed behavior, not a prompt. Transparent + deterministic.
 */
export type RpFeatures = {
  inbound: number;
  outbound: number;
  meetings: number;
  replyRate: number;
  initiationRatio: number;
  avgThreadDepth: number;
  lastDays: number | null;
  coldStart: boolean;
};

export function computeFeatures(interactions: Interaction[], now = new Date()): RpFeatures {
  if (interactions.length === 0) {
    return {
      inbound: 0,
      outbound: 0,
      meetings: 0,
      replyRate: 0,
      initiationRatio: 0,
      avgThreadDepth: 0,
      lastDays: null,
      coldStart: true,
    };
  }
  let inbound = 0;
  let outbound = 0;
  let meetings = 0;
  const threads = new Set<string>();
  let latest = 0;

  for (const it of interactions) {
    if (it.eventType === "email_in" || it.eventType === "message_in") inbound++;
    else if (it.eventType === "email_out" || it.eventType === "message_out") outbound++;
    else if (it.eventType === "meeting") meetings++;
    if (it.threadId) threads.add(it.threadId);
    const t = new Date(it.occurredAt).getTime();
    if (t > latest) latest = t;
  }

  const total = inbound + outbound || 1;
  const distinctThreads = threads.size || 1;
  return {
    inbound,
    outbound,
    meetings,
    replyRate: Math.min(1, outbound / Math.max(1, inbound)),
    initiationRatio: outbound / total,
    avgThreadDepth: (inbound + outbound) / distinctThreads,
    lastDays: latest ? Math.floor((now.getTime() - latest) / 86_400_000) : null,
    coldStart: false,
  };
}

/** 0..1. Initiation + replies dominate; meetings and depth add. */
export function scoreReplyPropensity(f: RpFeatures): number {
  if (f.coldStart) return 0.1;
  const meetingSignal = Math.min(1, f.meetings / 5);
  const depthSignal = Math.min(1, Math.max(0, f.avgThreadDepth - 1) / 4);
  const raw =
    0.45 * f.replyRate + 0.25 * f.initiationRatio + 0.15 * meetingSignal + 0.15 * depthSignal;
  return Math.max(0, Math.min(1, Number(raw.toFixed(4))));
}
