"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { userContext, connectedAccounts } from "@/db/schema";
import { getPrimaryUser, getConnectedAccount } from "@/lib/user";
import { enqueue, runOnce } from "@/worker/scheduler";

/**
 * Save the user's context (role, focus, projects, priority people, writing style).
 * The single biggest lever on relevance — recompute reads these — so we re-grade
 * immediately after saving.
 */
export async function saveContextAction(formData: FormData) {
  const user = await getPrimaryUser();
  if (!user) return;

  const get = (k: string) => {
    const v = formData.get(k);
    const s = v ? String(v).trim() : "";
    return s.length ? s : null;
  };

  const values = {
    role: get("role"),
    currentFocus: get("currentFocus"),
    activeProjects: get("activeProjects"),
    priorityConnections: get("priorityConnections"),
    writingStyle: get("writingStyle"),
    timezone: get("timezone") ?? "America/New_York",
  };

  const existing = (
    await db.select().from(userContext).where(eq(userContext.userId, user.id)).limit(1)
  )[0];

  if (existing) {
    await db
      .update(userContext)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(userContext.userId, user.id));
  } else {
    await db.insert(userContext).values({ userId: user.id, ...values });
  }

  await runOnce("recompute");
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/contacts");
}

/** Choose which specific Unipile account is linked for a provider (linkedin | email). */
export async function useAccount(formData: FormData) {
  const user = await getPrimaryUser();
  if (!user) return;
  const provider = String(formData.get("provider") ?? "");
  const externalId = String(formData.get("externalId") ?? "");
  const name = String(formData.get("name") ?? "") || null;
  const type = String(formData.get("type") ?? "") || null;
  if (!provider || !externalId) {
    revalidatePath("/dashboard/settings");
    return;
  }

  const existing = await getConnectedAccount(user.id, provider);
  const metadata = { name, type };
  if (existing) {
    await db
      .update(connectedAccounts)
      .set({ externalId, metadata })
      .where(eq(connectedAccounts.id, existing.id));
  } else {
    await db
      .insert(connectedAccounts)
      .values({ userId: user.id, provider, externalId, metadata });
  }
  revalidatePath("/dashboard/settings");
}

/** Unlink a provider (linkedin | email) in Rolodexa. Does not remove it from Unipile. */
export async function disconnectAccount(formData: FormData) {
  const user = await getPrimaryUser();
  if (!user) return;
  const provider = String(formData.get("provider") ?? "");
  if (!provider) return;
  await db
    .delete(connectedAccounts)
    .where(and(eq(connectedAccounts.userId, user.id), eq(connectedAccounts.provider, provider)));
  revalidatePath("/dashboard/settings");
}

/** Kick off an enrichment pass now (background via the queue). */
export async function enrichNowAction() {
  await enqueue("enrichment");
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/contacts");
}
