import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { connectedAccounts, contacts, interactions } from "@/db/schema";
import { isConfigured } from "@/lib/env";
import { listRecentMessages } from "@/lib/integrations/nylas";

/**
 * Light every-30-min poll: pull recent mail via Nylas and append idempotent
 * touchpoints to `interactions`. No-ops cleanly when Nylas is unconfigured.
 */
export async function runEmailPoll(): Promise<void> {
  if (!isConfigured("nylas")) {
    console.log("[emailPoll] nylas not configured — skip");
    return;
  }
  const grants = await db
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.provider, "nylas_email"));

  const since = Math.floor(Date.now() / 1000) - 3600;
  let inserted = 0;

  for (const g of grants) {
    if (!g.externalId) continue;
    const msgs = await listRecentMessages(g.externalId, since);
    for (const m of msgs) {
      const fromEmail = m.from?.[0]?.email?.toLowerCase();
      let contactId: string | null = null;
      if (fromEmail) {
        const found = await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.userId, g.userId), eq(contacts.email, fromEmail)))
          .limit(1);
        contactId = found[0]?.id ?? null;
      }
      await db
        .insert(interactions)
        .values({
          userId: g.userId,
          contactId,
          eventType: "email_in",
          direction: "inbound",
          channel: "nylas_email",
          threadId: m.threadId ?? null,
          occurredAt: new Date(m.date * 1000),
          sourceRef: m.id,
          metadata: { subject: m.subject ?? null },
        })
        .onConflictDoNothing();
      inserted++;
    }
  }
  console.log(`[emailPoll] processed ${inserted} messages across ${grants.length} grants`);
}
