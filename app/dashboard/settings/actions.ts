"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userContext } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { runOnce } from "@/worker/scheduler";

/**
 * Save the user's context (role, focus, projects, priority people). This is the
 * single biggest lever on relevance — `recompute` reads these to grade the whole
 * network, so we re-grade immediately after saving.
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
