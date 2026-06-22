import { NextResponse } from "next/server";

/**
 * Retired. This dev/admin endpoint previously seeded data and ran jobs from the
 * browser behind a hardcoded token. Those capabilities now live in Settings
 * (Background jobs) and the in-app flows. The path is kept only as a hard 404 so
 * it exposes nothing and accepts no token.
 */
export const dynamic = "force-dynamic";

function gone() {
  return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
}

export const GET = gone;
export const POST = gone;
