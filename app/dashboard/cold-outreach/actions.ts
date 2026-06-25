"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { coldProspects, interactions, userContext } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { promoteColdProspect } from "@/lib/sync/track";
import { clearBlacklistCache } from "@/lib/sync/noise";

/** Manually graduate a cold prospect into the real rolodex. */
export async function promoteColdAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const u = await getPrimaryUser();
  if (!u || !id) return;
  // Ownership check before mutating.
  const p = (
    await db
      .select({ id: coldProspects.id })
      .from(coldProspects)
      .where(and(eq(coldProspects.id, id), eq(coldProspects.userId, u.id)))
      .limit(1)
  )[0];
  if (!p) return;
  await promoteColdProspect(id);
  revalidatePath("/dashboard/cold-outreach");
}

/** Blacklist a prospect's email so it's never tracked again, and remove it now. */
export async function blacklistColdAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const u = await getPrimaryUser();
  if (!u || !id) return;
  const p = (
    await db
      .select()
      .from(coldProspects)
      .where(and(eq(coldProspects.id, id), eq(coldProspects.userId, u.id)))
      .limit(1)
  )[0];
  if (!p) return;

  const email = (p.email ?? "").toLowerCase().trim();
  if (email) {
    const ctx = (await db.select().from(userContext).where(eq(userContext.userId, u.id)).limit(1))[0];
    const next = Array.from(new Set([...((ctx?.blacklistedEmails ?? []) as string[]), email]));
    if (ctx) {
      await db.update(userContext).set({ blacklistedEmails: next }).where(eq(userContext.userId, u.id));
    } else {
      await db.insert(userContext).values({ userId: u.id, blacklistedEmails: next });
    }
    clearBlacklistCache(u.id);
  }
  await db.delete(interactions).where(and(eq(interactions.userId, u.id), eq(interactions.coldProspectId, id)));
  await db.delete(coldProspects).where(eq(coldProspects.id, id));
  revalidatePath("/dashboard/cold-outreach");
}
