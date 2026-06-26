/**
 * Conversation-based meeting detection — DISABLED.
 *
 * This job used to read message threads, ask an LLM whether a meeting had been scheduled,
 * and write inferred calendar_events (source="llm", "Meeting detected from conversation").
 * That guessing produced inaccurate entries (often dated to a message's timestamp) that
 * polluted the Calendar tab. The calendar now shows ONLY real synced events, and we no
 * longer create inferred ones. Kept as a no-op so the scheduler reference stays valid;
 * re-enable deliberately if a higher-precision detector is built.
 */
export async function runKpiAnalyze(): Promise<void> {
  console.log("[kpiAnalyze] conversation-based meeting detection disabled — skipping");
}
