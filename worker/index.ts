import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { env } from "@/lib/env";
import { runEmailPoll } from "./jobs/emailPoll";
import { runEnrichment } from "./jobs/enrichment";
import { runRecompute } from "./jobs/recompute";
import { runSuggestions } from "./jobs/suggestions";
import { runBrief } from "./jobs/brief";

/**
 * The Rolodexa worker service. Same codebase as the web app, different start
 * command (`npm run worker`). Overnight-heavy / daytime-light cadence on a
 * BullMQ queue (Railway Redis). Default timezone is the user's (ET).
 */
const TZ = "America/New_York";
const QUEUE = "rolodexa";

type JobDef = { name: string; cron: string; run: () => Promise<void> };

const JOBS: JobDef[] = [
  { name: "email-poll", cron: "*/30 * * * *", run: runEmailPoll },
  { name: "enrichment", cron: "0 2 * * *", run: runEnrichment },
  { name: "recompute", cron: "0 4 * * *", run: runRecompute },
  { name: "suggestions", cron: "0 6 * * *", run: runSuggestions },
  { name: "morning-brief", cron: "0 7 * * *", run: () => runBrief("morning-newsletter") },
  { name: "midday-brief", cron: "30 12 * * *", run: () => runBrief("midday-update") },
  { name: "night-brief", cron: "0 20 * * *", run: () => runBrief("night-brief") },
];

const byName = new Map(JOBS.map((j) => [j.name, j.run]));

async function runOnce(name: string): Promise<void> {
  const run = byName.get(name);
  if (!run) {
    console.error(`[worker] unknown job "${name}". Known: ${[...byName.keys()].join(", ")}`);
    return;
  }
  console.log(`[worker] manual run: ${name}`);
  await run();
}

async function main(): Promise<void> {
  const onceIdx = process.argv.indexOf("--once");
  if (onceIdx !== -1) {
    await runOnce(process.argv[onceIdx + 1]);
    process.exit(0);
  }

  if (!env.REDIS_URL) {
    console.warn(
      "[worker] REDIS_URL not set — scheduler idle. Add the Railway Redis plugin to enable scheduled jobs. (Use `--once <job>` to run one manually.)",
    );
    setInterval(() => undefined, 1 << 30);
    return;
  }

  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(QUEUE, { connection });

  for (const j of JOBS) {
    await queue.add(
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
      console.log(`[worker] running ${job.name}`);
      await run();
    },
    { connection },
  );

  worker.on("failed", (job, err) => console.error(`[worker] ${job?.name} failed:`, err));
  worker.on("completed", (job) => console.log(`[worker] ${job.name} ✓`));
  console.log(`[worker] online — ${JOBS.length} schedules registered (tz ${TZ}).`);
}

main().catch((e) => {
  console.error("[worker] fatal", e);
  process.exit(1);
});
