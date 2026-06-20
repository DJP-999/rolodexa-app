import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { users, userContext, connectedAccounts } from "@/db/schema";
import { env } from "@/lib/env";

/**
 * Single-user mode: the primary user is the first row, created on demand so the
 * app works before any auth is wired. Everything (contacts, context, suggestions)
 * hangs off this user.
 */
export async function getPrimaryUser() {
  const existing = (await db.select().from(users).limit(1))[0];
  if (existing) return existing;
  await db
    .insert(users)
    .values({ email: env.AUTH_DEV_USER_EMAIL, name: "Rolodexa" })
    .onConflictDoNothing();
  return (await db.select().from(users).limit(1))[0];
}

export async function getUserContextRow(userId: string) {
  return (
    (await db.select().from(userContext).where(eq(userContext.userId, userId)).limit(1))[0] ?? null
  );
}

export async function getConnectedAccount(userId: string, provider: string) {
  return (
    (
      await db
        .select()
        .from(connectedAccounts)
        .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, provider)))
        .limit(1)
    )[0] ?? null
  );
}
