import { Queue, Worker, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { jobRuns, automations } from "@/db/schema";
import { env } from "@/lib/env";
import { runWithProgress } from "@/lib/jobs/progress";
import { runEmailPoll } from "./jobs/emailPoll";
import { runLinkedinPoll } from "./jobs/linkedinPoll";
import { runMeetingsSync } from "./jobs/meetingsSync";
import { runKpiAnalyze } from "./jobs/kpiAnalyze";
import { runEnrichment } from "./jobs/enrichment";
import { runApifyEnrich } from "./jobs/apifyEnrich";
import { runApifyResolve } from "./jobs/apifyResolve";
import { runMessageBackfill } from "./jobs/messageBackfill";
import { runRecompute } from "./jobs/recompute";
import { runFitGrade } from "./jobs/fitGrade";
import { runPersonalProfile } from "./jobs/personalProfile";
import { runRemindersDue } from "./jobs/remindersDue";
import { runFollowThrough } from "./jobs/followThrough";
import { runSplitContacts } from "./jobs/splitContacts";
import { runPitchbookSync } from "./jobs/pitchbookSync";
import { runSuggestions } from "./jobs/suggestions";
import { runBrief } from "./jobs/brief";
import { runNewsScan } from "./jobs/newsScan";
import { runNormalize } from "./jobs/normalize";
import { runAutomation } from "./jobs/automation";

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
  { name: "reminders", cron: "*/15 * * * *", run: runRemindersDue },
  { name: "linkedin-poll", cron: "15,45 * * * *", run: runLinkedinPoll },
  { name: "meetings-sync", cron: "5 */2 * * *", run: runMeetingsSync },
  { name: "message-backfill", cron: "0 5 * * *", run: runMessageBackfill },
  { name: "kpi-analyze", cron: "30 5 * * *", run: runKpiAnalyze },
  { name: "split-contacts", cron: "30 1 * * *", run: runSplitContacts },
  { name: "pitchbook-sync", cron: "45 1 * * *", run: runPitchbookSync },
  { name: "apify-enrich", cron: "0 1 * * *", run: runApifyEnrich },
  { name: "apify-resolve", cron: "20 1 * * *", run: runApifyResolve },
  { name: "enrichment", cron: "0 2 * * *", run: runEnrichment },
  { name: "personal-profile", cron: "15 3 * * *", run: runPersonalProfile },
  { name: "fit-grade", cron: "30 3 * * *", run: runFitGrade },
  { name: "recompute", cron: "0 4 * * *", run: runRecompute },
  { name: "normalize", cron: "15 4 * * *", run: runNormalize },
  { name: "suggestions", cron: "0 6 * * *", run: runSuggestions },
  // Hourly: catch replies (ball in your court), silent threads to follow up, and slipping ties.
  { name: "follow-through", cron: "0 * * * *", run: runFollowThrough },
  { name: "morning-brief", cron: "0 7 * * *", run: () => runBrief("morning-newsletter") },
  { name: "midday-brief", cron: "30 12 * * *", run: () => runBrief("midday-update") },
  { name: "night-brief", cron: "0 20 * * *", run: () => runBrief("night-brief") },
  // Intraday news sweep of top relationships + breaking pings, between the briefs.
  { name: "news-scan", cron: "0 10,15,18 * * *", run: runNewsScan },
];

export const byName = new Map(JOBS.map((j) => [j.name, j.run]));

/** Record a job execution to job_runs so the home activity feed can show it. */
async function recordRun(name: string, fn: () => Promise<void>): Promise<void> {
  let id: string | undefined;
  try {
    const row = (
      await db.insert(jobRuns).values({ name, status: "running" }).returning({ id: jobRuns.id })
    )[0];
    id = row?.id;
  } catch (e) {
    console.error("[scheduler] jobRuns insert failed", e);
  }
  try {
    // Bind a progress context to this run row so the job can report live %/ETA into detail.
    await runWithProgress(id, fn);
    if (id)
      await db
        .update(jobRuns)
        .set({ status: "done", finishedAt: new Date() })
        .where(eq(jobRuns.id, id));
  } catch (e) {
    if (id)
      await db
        .update(jobRuns)
        .set({ status: "failed", finishedAt: new Date(), detail: { error: String(e) } })
        .where(eq(jobRuns.id, id));
    throw e;
  }
}

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
  if (!queue) queue = new Queue(QUEUE, { connection: c as unknown as ConnectionOptions });
  return queue;
}

let started = false;

export async function startScheduler(): Promise<void> {
  if (started) return;
  started = true;

  // A deploy/restart kills any in-flight job mid-run, leaving its job_runs row stuck on
  // "running" forever — which makes the UI show a phantom job and masks real completions.
  // On startup, close out any such orphans so the activity feed reflects reality.
  try {
    const orphaned = await db
      .update(jobRuns)
      .set({ status: "failed", finishedAt: new Date(), detail: { error: "interrupted by restart" } })
      .where(eq(jobRuns.status, "running"))
      .returning({ id: jobRuns.id });
    if (orphaned.length) console.log(`[scheduler] cleared ${orphaned.length} orphaned running job(s).`);
  } catch (e) {
    console.error("[scheduler] orphan cleanup failed", e);
  }

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

    // Register user-defined automations (custom prompts on a cron).
    try {
      const autos = await db.select().from(automations).where(eq(automations.enabled, true));
      for (const a of autos) {
        await q.add(
          `auto:${a.id}`,
          {},
          {
            repeat: { pattern: a.cron, tz: a.timezone ?? TZ },
            jobId: `auto:${a.id}`,
            removeOnComplete: true,
            removeOnFail: 20,
          },
        );
      }
      if (autos.length) console.log(`[scheduler] registered ${autos.length} custom automation(s).`);
    } catch (e) {
      console.error("[scheduler] automation load failed", e);
    }

    const worker = new Worker(
      QUEUE,
      async (job) => {
        if (job.name.startsWith("auto:")) {
          const id = job.name.slice("auto:".length);
          await recordRun(job.name, () => runAutomation(id));
          return;
        }
        const run = byName.get(job.name);
        if (!run) return;
        console.log(`[scheduler] running ${job.name}`);
        await recordRun(job.name, run);
      },
      { connection: c as unknown as ConnectionOptions },
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
  await recordRun(name, run);
}

/** Register a custom automation as a repeatable job (idempotent on jobId). */
export async function registerAutomation(id: string, cron: string, tz?: string): Promise<void> {
  const q = getQueue();
  if (!q) return;
  try {
    await q.add(
      `auto:${id}`,
      {},
      { repeat: { pattern: cron, tz: tz ?? TZ }, jobId: `auto:${id}`, removeOnComplete: true, removeOnFail: 20 },
    );
  } catch (e) {
    console.error("[scheduler] registerAutomation", e);
  }
}

/** Remove a custom automation's repeatable schedule. */
export async function unregisterAutomation(id: string): Promise<void> {
  const q = getQueue();
  if (!q) return;
  try {
    const reps = await q.getRepeatableJobs();
    for (const r of reps) if (r.name === `auto:${id}`) await q.removeRepeatableByKey(r.key);
  } catch (e) {
    console.error("[scheduler] unregisterAutomation", e);
  }
}

/** Run a custom automation immediately (inline), logging it like any job. */
export async function runAutomationOnce(id: string): Promise<void> {
  await recordRun(`auto:${id}`, () => runAutomation(id));
}
