import { env, isConfigured } from "@/lib/env";

/**
 * X (Twitter) adapter — read-only, App-only Bearer auth (X API v2).
 * Degrades to a logged no-op when X_BEARER_TOKEN is absent, like every other adapter.
 * Used to keep up with what a contact is publicly posting about.
 */

export type XUser = { id: string; name: string; username: string; verified?: boolean };
export type XTweet = { id: string; text: string; createdAt: string | null; url: string };

const BASE = "https://api.twitter.com/2";

async function xGet(path: string): Promise<any | null> {
  if (!isConfigured("x")) {
    console.warn(`[x] not configured — skipping ${path}`);
    return null;
  }
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${env.X_BEARER_TOKEN}` },
    });
    if (res.status === 429) {
      console.warn("[x] rate limited (429)");
      return null;
    }
    if (!res.ok) {
      console.error(`[x] ${path} → ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error(`[x] ${path}`, e);
    return null;
  }
}

/** Normalize a handle: strip URLs, leading @, whitespace. Returns null if not handle-shaped. */
export function normalizeHandle(raw: string): string | null {
  if (!raw) return null;
  let h = raw.trim();
  const m = h.match(/(?:x\.com|twitter\.com)\/(@?[A-Za-z0-9_]{1,15})(?:[/?#]|$)/i);
  if (m) h = m[1];
  h = h.replace(/^@/, "");
  // Exclude reserved/non-profile paths that slip through URL parsing.
  if (/^(home|status|i|intent|search|hashtag|share|explore|messages|notifications)$/i.test(h)) {
    return null;
  }
  return /^[A-Za-z0-9_]{1,15}$/.test(h) ? h : null;
}

/** Resolve a handle to an X user (id + display name) so we can fetch their timeline. */
export async function getXUserByUsername(handle: string): Promise<XUser | null> {
  const h = normalizeHandle(handle);
  if (!h) return null;
  const data = await xGet(`/users/by/username/${h}?user.fields=name,username,verified`);
  const u = data?.data;
  if (!u?.id) return null;
  return { id: String(u.id), name: String(u.name ?? h), username: String(u.username ?? h), verified: u.verified };
}

/** Recent ORIGINAL tweets (no retweets/replies), newest first, with absolute URLs. */
export async function getRecentTweets(
  userId: string,
  username: string,
  max = 10,
): Promise<XTweet[]> {
  const n = Math.min(Math.max(max, 5), 100);
  const data = await xGet(
    `/users/${userId}/tweets?max_results=${n}&exclude=retweets,replies&tweet.fields=created_at`,
  );
  const items: any[] = Array.isArray(data?.data) ? data.data : [];
  return items
    .filter((t) => t?.id && typeof t.text === "string")
    .map((t) => ({
      id: String(t.id),
      text: String(t.text),
      createdAt: typeof t.created_at === "string" ? t.created_at : null,
      url: `https://x.com/${username}/status/${t.id}`,
    }));
}
