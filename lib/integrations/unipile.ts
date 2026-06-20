import { env, isConfigured } from "@/lib/env";

/**
 * Unipile adapter — the user's own LinkedIn (profiles, relations, messages) and
 * email, reached through Unipile's hosted-auth session. We NEVER touch LinkedIn
 * credentials: the connection happens entirely in Unipile's hosted wizard, and we
 * only ever store the returned account_id. Every call degrades to null/[] when
 * unconfigured or on error, so the rest of the app runs without it.
 *
 * Responses are intentionally typed loosely and normalized defensively at the
 * call site, since exact shapes are confirmed against live data during wiring.
 */

type Client = any;
let clientPromise: Promise<Client> | null = null;

function dsnBase(): string {
  const d = env.UNIPILE_DSN ?? "";
  return d.startsWith("http") ? d : `https://${d}`;
}

async function getClient(): Promise<Client | null> {
  if (!isConfigured("unipile")) return null;
  if (!clientPromise) {
    clientPromise = import("unipile-node-sdk").then(
      (m: any) => new m.UnipileClient(dsnBase(), env.UNIPILE_API_KEY!),
    );
  }
  return clientPromise;
}

export function unipileConfigured(): boolean {
  return isConfigured("unipile");
}

/** All connected Unipile accounts — used to find the already-connected LinkedIn one. */
export async function listAccounts(): Promise<any[]> {
  const client = await getClient();
  if (!client) return [];
  try {
    const res: any = await client.account.getAll();
    return res?.items ?? res?.data ?? [];
  } catch (e) {
    console.error("[unipile] listAccounts", e);
    return [];
  }
}

/** Hosted-auth wizard URL for the user to connect LinkedIn (no credentials touched). */
export async function createHostedAuthLink(opts: {
  successUrl: string;
  failureUrl: string;
  notifyUrl: string;
  providers?: string[];
}): Promise<string | null> {
  const client = await getClient();
  if (!client) return null;
  try {
    const res: any = await client.account.createHostedAuthLink({
      type: "create",
      expiresOn: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      api_url: dsnBase(),
      providers: opts.providers ?? ["LINKEDIN"],
      success_redirect_url: opts.successUrl,
      failure_redirect_url: opts.failureUrl,
      notify_url: opts.notifyUrl,
    });
    if (typeof res === "string") return res;
    return res?.url ?? res?.hosted_auth_url ?? null;
  } catch (e) {
    console.error("[unipile] createHostedAuthLink", e);
    return null;
  }
}

/** The user's entire LinkedIn network, paginated and capped. Cheap relative to per-profile lookups. */
export async function getAllRelations(accountId: string, cap = 5000): Promise<any[]> {
  const client = await getClient();
  if (!client) return [];
  const out: any[] = [];
  let cursor: string | undefined;
  try {
    do {
      const res: any = await client.users.getAllRelations({
        account_id: accountId,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      const items: any[] = res?.items ?? res?.data ?? res?.relations ?? [];
      out.push(...items);
      cursor = res?.cursor ?? res?.paging?.cursor ?? res?.next_cursor ?? undefined;
    } while (cursor && out.length < cap);
  } catch (e) {
    console.error("[unipile] getAllRelations", e);
  }
  return out;
}

/** Full LinkedIn profile for one identifier (provider id or public id). Rate-limited upstream (~150/day). */
export async function getProfile(
  accountId: string,
  identifier: string,
  sections: string[] = ["experience", "about"],
): Promise<any | null> {
  const client = await getClient();
  if (!client) return null;
  try {
    return await client.users.getProfile({
      account_id: accountId,
      identifier,
      linkedin_sections: sections,
    });
  } catch (e) {
    console.error("[unipile] getProfile", e);
    return null;
  }
}

/** LinkedIn chats for the account; optionally only those after an ISO date. */
export async function getChats(accountId: string, after?: string): Promise<any[]> {
  const client = await getClient();
  if (!client) return [];
  try {
    const res: any = await client.messaging.getAllChats({
      account_type: "LINKEDIN",
      account_id: accountId,
      limit: 100,
      ...(after ? { after } : {}),
    });
    return res?.items ?? res?.data ?? [];
  } catch (e) {
    console.error("[unipile] getChats", e);
    return [];
  }
}

export async function getChatMessages(chatId: string): Promise<any[]> {
  const client = await getClient();
  if (!client) return [];
  try {
    const res: any = await client.messaging.getAllMessagesFromChat({ chat_id: chatId });
    return res?.items ?? res?.data ?? [];
  } catch (e) {
    console.error("[unipile] getChatMessages", e);
    return [];
  }
}

export async function getChatAttendees(chatId: string): Promise<any[]> {
  const client = await getClient();
  if (!client) return [];
  try {
    const res: any = await client.messaging.getAllAttendeesFromChat(chatId);
    return res?.items ?? res?.data ?? [];
  } catch (e) {
    console.error("[unipile] getChatAttendees", e);
    return [];
  }
}
