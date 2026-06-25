import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { connectedAccounts } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { listAccounts, unipileRawGet } from "@/lib/integrations/unipile";

/**
 * TEMPORARY read-only diagnostic: probe Unipile calendar endpoints to find the working
 * path for the connected Google account. Gated by a key. Retire after use.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get("k") !== "cal-diag-7x2") {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  const user = await getPrimaryUser();
  if (!user) return NextResponse.json({ ok: false, error: "no user" });

  const acct = (
    await db
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, user.id), eq(connectedAccounts.provider, "email")))
      .limit(1)
  )[0];
  const accountId = acct?.externalId ?? "";

  const accounts = await listAccounts();
  const match: any = accounts.find((a: any) => a?.id === accountId || a?.account_id === accountId);

  const candidates = [
    `/api/v1/calendars?account_id=${accountId}`,
    `/api/v1/calendar/calendars?account_id=${accountId}`,
    `/v1/calendar/calendars?account_id=${accountId}`,
    `/api/v1/calendars`,
    `/api/v1/calendar_events?account_id=${accountId}`,
  ];
  const probes = [];
  for (const path of candidates) {
    const r = await unipileRawGet(path);
    const b = r.body as any;
    probes.push({
      path,
      status: r.status,
      keys: b && typeof b === "object" ? Object.keys(b) : null,
      snippet: JSON.stringify(r.body).slice(0, 280),
    });
  }

  return NextResponse.json({
    ok: true,
    accountId,
    accountType: match?.type ?? match?.provider ?? null,
    sources: match?.sources ?? null,
    probes,
  });
}
