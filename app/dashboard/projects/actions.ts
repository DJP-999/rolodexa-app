"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";

export async function createProject(formData: FormData) {
  const user = await getPrimaryUser();
  if (!user) return;
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    revalidatePath("/dashboard/projects");
    return;
  }
  const oneLiner = String(formData.get("oneLiner") ?? "").trim() || null;
  const memoryDoc = String(formData.get("memoryDoc") ?? "").trim() || null;
  await db.insert(projects).values({ userId: user.id, name, oneLiner, memoryDoc });
  revalidatePath("/dashboard/projects");
}

export async function deleteProject(formData: FormData) {
  const id = String(formData.get("id"));
  await db.delete(projects).where(eq(projects.id, id));
  revalidatePath("/dashboard/projects");
}
