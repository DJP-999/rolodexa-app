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
 *   /api/admin?action=demo&token=...   ← backdate contacts past cadence, draft suggestions
 *
 * Remove this route once the app has real auth + onboarding wired.
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
    if (action === "demo") {
      // Force the contacts past their check-in cadence so the re-engage trigger
      // fires, then generate suggestions (Claude drafts a real message each).
      const { db } = await import("@/db");
      const { contacts } = await import("@/db/schema");
      await db.update(contacts).set({ lastContactedAt: new Date(Date.now() - 60 * 86_400_000) });
      const { runOnce } = await import("@/worker/scheduler");
      await runOnce("suggestions");
      return NextResponse.json({ ok: true, action, note: "backdated contacts 60d + generated suggestions" });
    }
    return NextResponse.json(
      { ok: false, error: "unknown action; use seed | run&job=... | demo" },
      { status: 400 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
