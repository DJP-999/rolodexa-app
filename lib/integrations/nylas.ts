import { env, isConfigured } from "@/lib/env";

/** Nylas adapter — email + calendar. Degrades to empty results when unconfigured. */
export type NylasMessage = {
  id: string;
  threadId?: string;
  from: { email: string; name?: string }[];
  to: { email: string; name?: string }[];
  subject?: string;
  snippet?: string;
  date: number;
  unread?: boolean;
};

export type NylasEvent = {
  id: string;
  title?: string;
  when: { startTime?: number; endTime?: number };
  participants: { email: string; name?: string }[];
};

async function nylasFetch<T>(path: string, params?: Record<string, string>): Promise<T | null> {
  if (!isConfigured("nylas")) {
    console.warn(`[nylas] not configured — skipping ${path}`);
    return null;
  }
  const url = new URL(`${env.NYLAS_API_URI}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.NYLAS_API_KEY}`, Accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`[nylas] ${path} → ${res.status}`);
    return null;
  }
  return (await res.json()) as T;
}

export async function listRecentMessages(grantId: string, sinceUnix: number): Promise<NylasMessage[]> {
  const data = await nylasFetch<{ data: NylasMessage[] }>(`/v3/grants/${grantId}/messages`, {
    received_after: String(sinceUnix),
    limit: "100",
  });
  return data?.data ?? [];
}

export async function getMessage(grantId: string, messageId: string): Promise<NylasMessage | null> {
  const data = await nylasFetch<{ data: NylasMessage }>(`/v3/grants/${grantId}/messages/${messageId}`);
  return data?.data ?? null;
}

export async function listEvents(grantId: string, startUnix: number, endUnix: number): Promise<NylasEvent[]> {
  const data = await nylasFetch<{ data: NylasEvent[] }>(`/v3/grants/${grantId}/events`, {
    start: String(startUnix),
    end: String(endUnix),
    limit: "100",
  });
  return data?.data ?? [];
}
