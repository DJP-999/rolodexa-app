import { NextResponse } from "next/server";

// Retired. This was a temporary read-only diagnostic for the Unipile calendar scope
// (confirmed: endpoint correct, but the Unipile API key lacks calendar scope). Kept as a
// hard 404 so the path exposes nothing.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
}
