/**
 * Next.js instrumentation — runs once when the server process starts.
 * Boots the BullMQ scheduler in-process so the briefs and nightly jobs run
 * inside the (already correctly-configured) web service. No separate worker
 * service required. Fire-and-forget so it never blocks server startup.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("@/worker/scheduler");
    void startScheduler();
  }
}
