"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  userContext,
  connectedAccounts,
  contacts,
  claims,
  suggestions,
  interactions,
  notificationEvents,
  projects,
  automations,
  messageLog,
} from "@/db/schema";
import { getPrimaryUser, getConnectedAccount } from "@/lib/user";
import { createHostedAuthLink } from "@/lib/integrations/unipile";
import { sendMessage } from "@/lib/integrations/telegram";
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

  // Track whether the writing style is a hand edit (manual) or left to Dexa (auto).
  // Clearing the field resumes auto-learning; editing it pins the user's own wording.
  const styleVal = values.writingStyle;
  const styleChanged = styleVal !== (existing?.writingStyle ?? null);
  const styleFields =
    styleVal === null
      ? { writingStyleSource: "auto", writingStyleSamples: 0, writingStyleUpdatedAt: null }
      : styleChanged
        ? { writingStyleSource: "manual", writingStyleUpdatedAt: new Date() }
        : {};

  if (existing) {
    await db
      .update(userContext)
      .set({ ...values, ...styleFields, updatedAt: new Date() })
      .where(eq(userContext.userId, user.id));
  } else {
    await db.insert(userContext).values({ userId: user.id, ...values, ...styleFields });
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

/**
 * Launch Unipile's hosted-auth wizard to connect a NEW account (e.g. the
 * dp@djpcapital.io mailbox). The user completes the secure flow on Unipile and is
 * redirected back here, where the new account shows up in the picker. We never
 * touch their credentials.
 */
export async function connectNewAccount() {
  const h = await headers();
  const host = h.get("host") ?? "";
  const base = host ? `https://${host}` : "";
  const url = await createHostedAuthLink({
    successUrl: `${base}/dashboard/settings`,
    failureUrl: `${base}/dashboard/settings`,
    notifyUrl: `${base}/api/unipile/webhook`,
    providers: ["GOOGLE", "OUTLOOK", "MAIL", "LINKEDIN"],
  });
  if (url) redirect(url);
  revalidatePath("/dashboard/settings");
}

/** Kick off an enrichment pass now (background via the queue). */
export async function enrichNowAction() {
  await enqueue("enrichment");
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/contacts");
}

/** Persist editable scoring weights and re-grade. replyPropensity stays internal. */
export async function saveWeights(formData: FormData) {
  const user = await getPrimaryUser();
  if (!user) return;
  const num = (k: string, d: number) => {
    const v = Number(formData.get(k));
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  const weights = {
    professional: num("professional", 30),
    recency: num("recency", 25),
    relationship: num("relationship", 20),
    geographic: num("geographic", 15),
    trigger: num("trigger", 10),
    replyPropensity: 10,
  };
  const existing = (
    await db.select().from(userContext).where(eq(userContext.userId, user.id)).limit(1)
  )[0];
  if (existing) {
    await db.update(userContext).set({ weights, updatedAt: new Date() }).where(eq(userContext.userId, user.id));
  } else {
    await db.insert(userContext).values({ userId: user.id, weights });
  }
  await runOnce("recompute");
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/contacts");
}

/** Run a background job on demand (Run Now). */
export async function runJobAction(formData: FormData) {
  const job = String(formData.get("job") ?? "");
  if (job) await enqueue(job);
  revalidatePath("/dashboard/settings");
}

/** Send a Telegram test message to confirm delivery works. */
export async function telegramTestAction() {
  const user = await getPrimaryUser();
  if (!user) return;
  const tg = await getConnectedAccount(user.id, "telegram");
  if (tg?.externalId) {
    await sendMessage(tg.externalId, "✅ Test from Rolodexa — Dexa can reach you here.");
  }
  revalidatePath("/dashboard/settings");
}

/** Disconnect the Telegram chat link. */
export async function telegramDisconnectAction() {
  const user = await getPrimaryUser();
  if (!user) return;
  await db
    .delete(connectedAccounts)
    .where(and(eq(connectedAccounts.userId, user.id), eq(connectedAccounts.provider, "telegram")));
  revalidatePath("/dashboard/settings");
}

/** Clear enrichment + claims and re-discover from scratch on the next run. */
export async function resetEnrichmentAction() {
  const user = await getPrimaryUser();
  if (!user) return;
  const ids = (
    await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.userId, user.id))
  ).map((r) => r.id);
  if (ids.length) await db.delete(claims).where(inArray(claims.contactId, ids));
  await db
    .update(contacts)
    .set({ enrichedAt: null, gradedAt: null, summary: null })
    .where(eq(contacts.userId, user.id));
  await db
    .update(userContext)
    .set({ firstEnrichDone: false })
    .where(eq(userContext.userId, user.id));
  await enqueue("enrichment");
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/contacts");
}

/** Danger zone: wipe all of the user's data. Gated by typing RESET. */
export async function resetAllDataAction(formData: FormData) {
  if (String(formData.get("confirm")) !== "RESET") {
    revalidatePath("/dashboard/settings");
    return;
  }
  const user = await getPrimaryUser();
  if (!user) return;
  const ids = (
    await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.userId, user.id))
  ).map((r) => r.id);
  if (ids.length) await db.delete(claims).where(inArray(claims.contactId, ids));
  await db.delete(interactions).where(eq(interactions.userId, user.id));
  await db.delete(suggestions).where(eq(suggestions.userId, user.id));
  await db.delete(notificationEvents).where(eq(notificationEvents.userId, user.id));
  await db.delete(messageLog).where(eq(messageLog.userId, user.id));
  await db.delete(projects).where(eq(projects.userId, user.id));
  await db.delete(automations).where(eq(automations.userId, user.id));
  await db.delete(connectedAccounts).where(eq(connectedAccounts.userId, user.id));
  await db.delete(contacts).where(eq(contacts.userId, user.id));
  await db
    .update(userContext)
    .set({
      firstEnrichDone: false,
      writingStyle: null,
      writingStyleSource: "auto",
      writingStyleSamples: 0,
      writingStyleUpdatedAt: null,
    })
    .where(eq(userContext.userId, user.id));
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/contacts");
  revalidatePath("/dashboard");
}
