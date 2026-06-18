/**
 * Standalone worker entry — optional. The scheduler now runs in-process with the
 * web server (see instrumentation.ts), so a separate Railway worker service is
 * NOT required. This file remains for local use and manual one-off job runs:
 *   npm run worker -- --once recompute
 */
import { startScheduler, runOnce } from "./scheduler";

async function main() {
  const onceIdx = process.argv.indexOf("--once");
  if (onceIdx !== -1) {
    await runOnce(process.argv[onceIdx + 1]);
    process.exit(0);
  }
  await startScheduler();
}

main().catch((e) => {
  console.error("[worker] fatal", e);
  process.exit(1);
});
