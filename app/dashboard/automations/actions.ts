"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { automations } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import {
  registerAutomation,
  unregisterAutomation,
  runAutomationOnce,
} from "@/worker/scheduler";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "automation";
}

/** time "HH:MM" → daily cron "M H * * *". */
function dailyCron(time: string): string {
  const [hh, mm] = (time || "09:00").split(":");
  return `${parseInt(mm || "0", 10)} ${parseInt(hh || "9", 10)} * * *`;
}

export async function createAutomation(formData: FormData) {
  const user = await getPrimaryUser();
  if (!user) return;
  const name = String(formData.get("name") ?? "").trim() || "Untitled automation";
  const description = String(formData.get("description") ?? "").trim() || null;
  const prompt = String(formData.get("prompt") ?? "").trim();
  const time = String(formData.get("time") ?? "09:00");
  const tz = String(formData.get("timezone") ?? "America/New_York") || "America/New_York";
  if (!prompt) {
    revalidatePath("/dashboard/automations");
    return;
  }
  const cron = dailyCron(time);
  const [row] = await db
    .insert(automations)
    .values({ userId: user.id, slug: slugify(name), name, description, cron, timezone: tz, prompt, enabled: true })
    .returning({ id: automations.id });
  if (row?.id) await registerAutomation(row.id, cron, tz);
  revalidatePath("/dashboard/automations");
}

export async function toggleAutomation(formData: FormData) {
  const id = String(formData.get("id"));
  const a = (await db.select().from(automations).where(eq(automations.id, id)).limit(1))[0];
  if (!a) return;
  const enabled = !a.enabled;
  await db.update(automations).set({ enabled }).where(eq(automations.id, id));
  if (enabled) await registerAutomation(id, a.cron, a.timezone ?? undefined);
  else await unregisterAutomation(id);
  revalidatePath("/dashboard/automations");
}

export async function deleteAutomation(formData: FormData) {
  const id = String(formData.get("id"));
  await unregisterAutomation(id);
  await db.delete(automations).where(eq(automations.id, id));
  revalidatePath("/dashboard/automations");
}

export async function runAutomationNow(formData: FormData) {
  const id = String(formData.get("id"));
  await runAutomationOnce(id);
  revalidatePath("/dashboard/automations");
}
