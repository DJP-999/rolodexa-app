import { AsyncLocalStorage } from "node:async_hooks";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { jobRuns } from "@/db/schema";

/**
 * Live job progress. The scheduler runs in-process with the web server, and the activity API
 * already reads the `job_runs` table — so a long job writes its processed/total/phase into its
 * own run row's `detail`, throttled, and the UI surfaces a live %, remaining count, and ETA.
 *
 * Bound to the run via AsyncLocalStorage so reportProgress() needs no plumbing through every
 * job signature and is correct even if two jobs run concurrently.
 */

export type JobProgress = {
  phase: string | null;
  processed: number;
  total: number;
  pct: number;
  etaMs: number;
  at: number;
};

type Ctx = { runId: string; startedAt: number; last: number };
const store = new AsyncLocalStorage<Ctx>();

/** Run a job fn inside a progress context bound to its job_runs row (no-op without an id). */
export function runWithProgress<T>(runId: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!runId) return fn();
  return store.run({ runId, startedAt: Date.now(), last: 0 }, fn);
}

async function write(ctx: Ctx, p: JobProgress): Promise<void> {
  try {
    await db.update(jobRuns).set({ detail: p }).where(eq(jobRuns.id, ctx.runId));
  } catch (e) {
    console.error("[progress] write", e);
  }
}

/**
 * Report incremental progress for the CURRENT job. Throttled to ~1 write/sec; the final tick
 * (processed >= total) always writes. No-op outside a job context.
 */
export async function reportProgress(processed: number, total: number, phase?: string): Promise<void> {
  const ctx = store.getStore();
  if (!ctx) return;
  const now = Date.now();
  const done = total > 0 && processed >= total;
  if (!done && now - ctx.last < 1000) return;
  ctx.last = now;
  const elapsed = now - ctx.startedAt;
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const etaMs = processed > 0 && total > processed ? Math.round((elapsed / processed) * (total - processed)) : 0;
  await write(ctx, { phase: phase ?? null, processed, total, pct, etaMs, at: now });
}

/** Set just a phase label (indeterminate — no count yet), e.g. "Reconciling profiles". */
export async function reportPhase(phase: string): Promise<void> {
  const ctx = store.getStore();
  if (!ctx) return;
  ctx.last = Date.now();
  await write(ctx, { phase, processed: 0, total: 0, pct: 0, etaMs: 0, at: ctx.last });
}
