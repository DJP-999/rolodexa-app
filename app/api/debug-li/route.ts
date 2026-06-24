import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { connectedAccounts } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { getChats, getChatAttendees } from "@/lib/integrations/unipile";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * TEMPORARY read-only diagnostic for the LinkedIn message-sync bug. Returns the
 * shape of Unipile chat/attendee objects + whether Spencer/Morgan's chats appear.
 * Gated by a throwaway key; removed once the sync is fixed.
 */
export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get("k") !== "li-diag-9f3") {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  const user = await getPrimaryUser();
  if (!user) return NextResponse.json({ error: "no user" });
  const acc = (
    await db
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, user.id), eq(connectedAccounts.provider, "linkedin")))
      .limit(1)
  )[0];
  if (!acc?.externalId) return NextResponse.json({ error: "no linkedin account bound" });

  const chats = await getChats(acc.externalId);
  const sample = chats.slice(0, 3).map((c: any) => ({
    keys: Object.keys(c),
    id: c.id,
    attendee_provider_id: c.attendee_provider_id,
    attendee_name: c.attendee_name,
    name: c.name,
    subject: c.subject,
  }));
  let attendees: any = null;
  const firstId = chats[0]?.id;
  if (firstId) {
    const atts = await getChatAttendees(String(firstId));
    attendees = (atts ?? []).slice(0, 4).map((a: any) => ({
      keys: Object.keys(a),
      name: a.name,
      display_name: a.display_name,
      provider_id: a.provider_id,
      is_self: a.is_self,
    }));
  }
  const hit = (q: string) =>
    chats.filter((c: any) => JSON.stringify(c).toLowerCase().includes(q)).slice(0, 2);
  return NextResponse.json({
    chatCount: chats.length,
    sample,
    firstChatAttendees: attendees,
    spencer: hit("spencer"),
    morgan: hit("morgan"),
  });
}
