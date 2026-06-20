import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { env } from "@/lib/env";
import { runEmailPoll } from "./jobs/emailPoll";
import { runEnrichment } from "./jobs/enrichment";
import { runRecompute } from "./jobs/recompute";
import { runSuggestions } from "./jobs/suggestions";
import { runBrief } from "./jobs/brief";

/**
 * The scheduler. Runs in-process with the web server (via instrumentation.ts) so
 * there's a single Railway service with one correct set of variables. Overnight-
 * heavy / daytime-light cadence, timezone ET. Error-safe: a Redis hiccup never
 * takes down the web server.
 */
const TZ = "America/New_York";
const QUEUE = "rolodexa";

type JobDef = { name: string; cron: string; run: () => Promise<void> };

export const JOBS: JobDef[] = [
  { name: "email-poll", cron: "*/30 * * * *", run: runEmailPoll },
  { name: "enrichment", cron: "0 2 * * *", run: runEnrichment },
  { name: "recompute", cron: "0 4 * * *", run: runRecompute },
  { name: "suggestions", cron: "0 6 * * *", run: runSuggestions },
  { name: "morning-brief", cron: "0 7 * * *", run: () => runBrief("morning-newsletter") },
  { name: "midday-brief", cron: "30 12 * * *", run: () => runBrief("midday-update") },
  { name: "night-brief", cron: "0 20 * * *", run: () => runBrief("night-brief") },
];

export const byName = new Map(JOBS.map((j) => [j.name, j.run]));

let connection: IORedis | null = null;
let queue: Queue | null = null;

function getConnection(): IORedis | null {
  if (!env.REDIS_URL) return null;
  if (!connection) connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

function getQueue(): Queue | null {
  const c = getConnection();
  if (!c) return null;
  if (!queue) queue = new Queue(QUEUE, { connection: c });
  return queue;
}

let started = false;

export async function startScheduler(): Promise<void> {
  if (started) return;
  started = true;
  try {
    const c = getConnection();
    if (!c) {
      console.warn("[scheduler] REDIS_URL not set — scheduler idle.");
      return;
    }
    const q = getQueue()!;

    for (const j of JOBS) {
      await q.add(
        j.name,
        {},
        { repeat: { pattern: j.cron, tz: TZ }, jobId: j.name, removeOnComplete: true, removeOnFail: 50 },
      );
    }

    const worker = new Worker(
      QUEUE,
      async (job) => {
        const run = byName.get(job.name);
        if (!run) return;
        console.log(`[scheduler] running ${job.name}`);
        await run();
      },
      { connection: c },
    );
    worker.on("failed", (job, err) => console.error(`[scheduler] ${job?.name} failed:`, err));
    worker.on("completed", (job) => console.log(`[scheduler] ${job.name} ✓`));

    console.log(`[scheduler] online — ${JOBS.length} schedules registered (tz ${TZ}).`);
  } catch (e) {
    console.error("[scheduler] failed to start (web server unaffected):", e);
  }
}

/** Fire-and-forget a one-off job run via the queue; falls back to inline if Redis is absent. */
export async function enqueue(name: string): Promise<void> {
  const q = getQueue();
  if (!q) {
    await runOnce(name);
    return;
  }
  try {
    await q.add(name, {}, { removeOnComplete: true, removeOnFail: 20 });
  } catch (e) {
    console.error("[scheduler] enqueue failed, running inline:", e);
    await runOnce(name);
  }
}

export async function runOnce(name: string): Promise<void> {
  const run = byName.get(name);
  if (!run) {
    console.error(`[scheduler] unknown job "${name}". Known: ${[...byName.keys()].join(", ")}`);
    return;
  }
  console.log(`[scheduler] manual run: ${name}`);
  await run();
}
