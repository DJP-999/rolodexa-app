import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { connectedAccounts } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { nylasExchangeCode } from "@/lib/integrations/nylas";
import { enqueue } from "@/worker/scheduler";

export const dynamic = "force-dynamic";

/** Nylas v3 OAuth callback — exchanges the code for a grant and stores the calendar connection. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const base = `${url.protocol}//${url.host}`;
  const code = url.searchParams.get("code");
  const settings = `${base}/dashboard/settings`;
  if (!code) return NextResponse.redirect(`${settings}?cal=error`);

  const grant = await nylasExchangeCode(code, `${base}/api/nylas/callback`);
  const user = await getPrimaryUser();
  if (!grant?.grantId || !user) return NextResponse.redirect(`${settings}?cal=error`);

  const existing = (
    await db
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, user.id), eq(connectedAccounts.provider, "nylas_calendar")))
      .limit(1)
  )[0];
  const metadata = { email: grant.email };
  if (existing) {
    await db
      .update(connectedAccounts)
      .set({ externalId: grant.grantId, metadata })
      .where(eq(connectedAccounts.id, existing.id));
  } else {
    await db
      .insert(connectedAccounts)
      .values({ userId: user.id, provider: "nylas_calendar", externalId: grant.grantId, metadata });
  }

  // Pull the calendar immediately so the Calendar tab populates without waiting for the cron.
  await enqueue("meetings-sync");
  return NextResponse.redirect(`${settings}?cal=connected`);
}
