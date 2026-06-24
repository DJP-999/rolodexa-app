import { NextResponse } from "next/server";

// Retired. This was a temporary read-only diagnostic for the LinkedIn message-sync
// bug (now fixed). Kept as a hard 404 so the path exposes nothing.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
}
