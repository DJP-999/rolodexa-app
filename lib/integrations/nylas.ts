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

// Nylas v3 event shapes are snake_case. `when.object` is "timespan" (start_time/end_time),
// "date"/"datespan" (all-day), so we read all variants defensively.
export type NylasEvent = {
  id: string;
  title?: string;
  when: {
    object?: string;
    start_time?: number;
    end_time?: number;
    date?: string;
    start_date?: string;
  };
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

export async function listEvents(
  grantId: string,
  startUnix: number,
  endUnix: number,
  calendarId = "primary",
): Promise<NylasEvent[]> {
  // Nylas v3 requires calendar_id on the events endpoint.
  const data = await nylasFetch<{ data: NylasEvent[] }>(`/v3/grants/${grantId}/events`, {
    calendar_id: calendarId,
    start: String(startUnix),
    end: String(endUnix),
    limit: "200",
  });
  return data?.data ?? [];
}

/** Nylas v3 hosted-OAuth URL to authorize a Google/Microsoft calendar. */
export function nylasAuthUrl(redirectUri: string): string | null {
  if (!env.NYLAS_CLIENT_ID) return null;
  const u = new URL(`${env.NYLAS_API_URI}/v3/connect/auth`);
  u.searchParams.set("client_id", env.NYLAS_CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("provider", "google");
  u.searchParams.set("access_type", "offline");
  return u.toString();
}

/** Exchange the OAuth code for a Nylas grant id (the calendar connection handle). */
export async function nylasExchangeCode(
  code: string,
  redirectUri: string,
): Promise<{ grantId: string; email: string | null } | null> {
  if (!env.NYLAS_API_KEY || !env.NYLAS_CLIENT_ID) return null;
  try {
    const res = await fetch(`${env.NYLAS_API_URI}/v3/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env.NYLAS_CLIENT_ID,
        client_secret: env.NYLAS_API_KEY,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code,
      }),
    });
    if (!res.ok) {
      console.error(`[nylas] token exchange → ${res.status}`);
      return null;
    }
    const data: any = await res.json();
    if (!data?.grant_id) return null;
    return { grantId: String(data.grant_id), email: data.email ?? null };
  } catch (e) {
    console.error("[nylas] exchangeCode", e);
    return null;
  }
}
