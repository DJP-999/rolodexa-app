import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Unipile hosted-auth notify endpoint. Nothing needs persisting here — a newly
 * connected account shows up via listAccounts() in the Settings picker — so we
 * just acknowledge. Logged for debugging the connect flow.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    console.log("[unipile/webhook]", JSON.stringify(body)?.slice(0, 500));
  } catch {
    /* ignore */
  }
  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ ok: true });
}
