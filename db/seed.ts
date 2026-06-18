/**
 * Dev seed: a user + context (with an active 7-day observation window) + a few
 * contacts and interactions, so the dashboard shows data and `recompute` has
 * real behavior to learn from. Run: npm run db:seed
 */
import { db } from "@/db";
import { users, userContext, contacts, interactions } from "@/db/schema";

async function main() {
  const email = process.env.AUTH_DEV_USER_EMAIL ?? "dev@rolodexa.local";
  const existing = (await db.select().from(users).limit(1))[0];
  const user =
    existing ??
    (await db.insert(users).values({ email, name: "Dom" }).returning())[0];

  await db
    .insert(userContext)
    .values({
      userId: user.id,
      role: "Investor",
      currentFocus: "LP relations",
      priorityConnections: "Prospective LPs",
      activeProjects: "Connecting with secondaries investors",
      timezone: "America/New_York",
      // observation window: no proactive sends for 7 days while it learns.
      observationUntil: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    })
    .onConflictDoNothing();

  const sample: [string, string, "investor" | "other" | "friend"][] = [
    ["Kevin Henderson", "Ion Pacific", "investor"],
    ["Jennifer Prosek", "Prosek Partners", "other"],
    ["Nathan Lehman", "Next Round Capital", "investor"],
  ];

  for (const [name, company, rel] of sample) {
    const [c] = await db
      .insert(contacts)
      .values({
        userId: user.id,
        name,
        company,
        relationship: rel,
        email: name.toLowerCase().replace(/\W+/g, ".") + "@example.com",
      })
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
  }

  console.log(`[seed] done — user ${user.email} + ${sample.length} contacts.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[seed] failed", e);
  process.exit(1);
});
