"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userContext, connectedAccounts } from "@/db/schema";
import { getPrimaryUser, getConnectedAccount } from "@/lib/user";
import { listAccounts } from "@/lib/integrations/unipile";
import { enqueue, runOnce } from "@/worker/scheduler";

/**
 * Save the user's context (role, focus, projects, priority people). The single
 * biggest lever on relevance — recompute reads these to grade the whole network,
 * so we re-grade immediately after saving.
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

/**
 * Link the user's already-connected Unipile LinkedIn account by discovering its
 * account_id (type === "LINKEDIN") and storing it. No credentials are touched.
 */
export async function linkLinkedInAction() {
  const user = await getPrimaryUser();
  if (!user) return;

  const accounts = await listAccounts();
  const li = accounts.find((a: any) => String(a?.type).toUpperCase() === "LINKEDIN");
  if (!li?.id) {
    revalidatePath("/dashboard/settings");
    return;
  }

  const existing = await getConnectedAccount(user.id, "linkedin");
  if (existing) {
    await db
      .update(connectedAccounts)
      .set({ externalId: li.id, metadata: { name: li.name ?? null } })
      .where(eq(connectedAccounts.id, existing.id));
  } else {
    await db.insert(connectedAccounts).values({
      userId: user.id,
      provider: "linkedin",
      externalId: li.id,
      metadata: { name: li.name ?? null },
    });
  }
  revalidatePath("/dashboard/settings");
}

/**
 * Link the user's Gmail/Outlook account connected in Unipile (type GOOGLE/MAIL/
 * OUTLOOK) so email message history flows into interactions.
 */
export async function linkEmailAction() {
  const user = await getPrimaryUser();
  if (!user) return;

  const accounts = await listAccounts();
  const em = accounts.find((a: any) =>
    ["GOOGLE", "MAIL", "OUTLOOK"].includes(String(a?.type).toUpperCase()),
  );
  if (!em?.id) {
    revalidatePath("/dashboard/settings");
    return;
  }

  const existing = await getConnectedAccount(user.id, "email");
  const metadata = { name: em.name ?? null, type: em.type ?? null };
  if (existing) {
    await db
      .update(connectedAccounts)
      .set({ externalId: em.id, metadata })
      .where(eq(connectedAccounts.id, existing.id));
  } else {
    await db
      .insert(connectedAccounts)
      .values({ userId: user.id, provider: "email", externalId: em.id, metadata });
  }
  revalidatePath("/dashboard/settings");
}

/** Kick off an enrichment pass now (background via the queue). */
export async function enrichNowAction() {
  await enqueue("enrichment");
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/contacts");
}
