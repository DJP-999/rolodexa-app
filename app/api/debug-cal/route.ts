import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { connectedAccounts } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { listAccounts, getCalendars, getCalendarEvents } from "@/lib/integrations/unipile";

/**
 * TEMPORARY read-only diagnostic: does the connected email account expose a calendar?
 * Gated by a key. Returns the Unipile account capabilities + calendar/event counts so
 * we can tell "no calendar scope" from "no email-matched meetings". Retire after use.
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
  const accountId = acct?.externalId ?? null;

  const accounts = await listAccounts();
  const match: any = accounts.find((a: any) => a?.id === accountId || a?.account_id === accountId);

  let calendars: any[] = [];
  let firstCalendarEventCount = 0;
  let firstCal: string | null = null;
  if (accountId) {
    calendars = await getCalendars(accountId);
    firstCal = calendars[0]?.id ?? calendars[0]?.calendar_id ?? calendars[0]?.email ?? null;
    if (firstCal) firstCalendarEventCount = (await getCalendarEvents(accountId, String(firstCal))).length;
  }

  return NextResponse.json({
    ok: true,
    accountId,
    accountType: match?.type ?? match?.provider ?? null,
    accountKeys: match ? Object.keys(match) : null,
    sources: match?.sources ?? match?.connection_params ?? null,
    calendarsCount: calendars.length,
    calendarSample: calendars.slice(0, 3).map((c: any) => ({
      id: c?.id ?? c?.calendar_id ?? c?.email ?? null,
      name: c?.name ?? c?.summary ?? c?.email ?? null,
    })),
    firstCalendarEventCount,
  });
}
