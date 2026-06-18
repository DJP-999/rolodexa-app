import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Temporary dev/admin endpoint — seed data and run jobs on demand from the
 * browser (no terminal needed). Runs in the Next runtime so `@/` imports
 * resolve cleanly. Token-gated to prevent accidental triggering.
 *
 *   /api/admin?action=seed&token=...
 *   /api/admin?action=run&job=recompute&token=...
 *   /api/admin?action=run&job=suggestions&token=...
 *
 * Remove this route (and rotate nothing — the token isn't a real credential)
 * once the app has real auth + onboarding wired.
 */
const TOKEN = "rolodexa-init-7x29qk";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== TOKEN) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const action = url.searchParams.get("action");
  try {
    if (action === "seed") {
      const { seed } = await import("@/db/seed-fn");
      const result = await seed();
      return NextResponse.json({ ok: true, action, ...result });
    }
    if (action === "run") {
      const job = url.searchParams.get("job") ?? "";
      const { runOnce } = await import("@/worker/scheduler");
      await runOnce(job);
      return NextResponse.json({ ok: true, action, job });
    }
    return NextResponse.json(
      { ok: false, error: "unknown action; use ?action=seed or ?action=run&job=recompute|suggestions" },
      { status: 400 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
