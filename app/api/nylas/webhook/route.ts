import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Nylas webhook. GET returns the challenge (verification handshake). POST
 * receives message/event notifications; near-real-time ingestion supplements
 * the 30-min poll. Full ETL wiring lands with the Phase 0 interactions backfill.
 */
export async function GET(req: Request) {
  const challenge = new URL(req.url).searchParams.get("challenge");
  if (challenge) return new NextResponse(challenge, { status: 200 });
  return NextResponse.json({ ok: true });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    console.log("[nylas/webhook] event:", body?.type ?? "unknown");
    // TODO(Phase 0 / A2): resolve grant→user, upsert into `interactions` idempotently.
  } catch {
    /* ignore malformed */
  }
  return NextResponse.json({ ok: true });
}
