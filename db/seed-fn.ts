import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { users, userContext, contacts, interactions } from "@/db/schema";

/**
 * Idempotent dev seed callable from the runtime (used by /api/admin?action=seed).
 * Creates a user + context (with a 7-day observation window) + a few contacts
 * with interactions, so `recompute` and `suggestions` have something to chew on.
 */
export async function seed(): Promise<{ userEmail: string; contactsCreated: number }> {
  const email = process.env.AUTH_DEV_USER_EMAIL ?? "dev@rolodexa.local";
  const existing = (await db.select().from(users).limit(1))[0];
  const user = existing ?? (await db.insert(users).values({ email, name: "Dom" }).returning())[0];

  await db
    .insert(userContext)
    .values({
      userId: user.id,
      role: "Investor",
      currentFocus: "LP relations",
      priorityConnections: "Prospective LPs",
      activeProjects: "Connecting with secondaries investors",
      timezone: "America/New_York",
      observationUntil: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    })
    .onConflictDoNothing();

  const sample: [string, string, "investor" | "other" | "friend"][] = [
    ["Kevin Henderson", "Ion Pacific", "investor"],
    ["Jennifer Prosek", "Prosek Partners", "other"],
    ["Nathan Lehman", "Next Round Capital", "investor"],
  ];

  let created = 0;
  for (const [name, company, rel] of sample) {
    const e = `${name.toLowerCase().replace(/\W+/g, ".")}@example.com`;
    const dup = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.userId, user.id), eq(contacts.email, e)))
      .limit(1);
    if (dup.length) continue;

    const [c] = await db
      .insert(contacts)
      .values({ userId: user.id, name, company, relationship: rel, email: e })
      .returning();
    const now = Date.now();
    await db
      .insert(interactions)
      .values([
        {
          userId: user.id,
          contactId: c.id,
          eventType: "email_in",
          direction: "inbound",
          channel: "nylas_email",
          threadId: `${c.id}-t1`,
          occurredAt: new Date(now - 40 * 86_400_000),
          sourceRef: `${c.id}-1`,
        },
        {
          userId: user.id,
          contactId: c.id,
          eventType: "email_out",
          direction: "outbound",
          channel: "nylas_email",
          threadId: `${c.id}-t1`,
          occurredAt: new Date(now - 39 * 86_400_000),
          sourceRef: `${c.id}-2`,
        },
      ])
      .onConflictDoNothing();
    created++;
  }

  return { userEmail: user.email, contactsCreated: created };
}
