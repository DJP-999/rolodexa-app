"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { coldProspects } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { promoteColdProspect } from "@/lib/sync/track";

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
