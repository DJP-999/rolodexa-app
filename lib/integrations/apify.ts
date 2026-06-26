import { env } from "@/lib/env";

/**
 * Apify adapter — bulk LinkedIn profile enrichment that is NOT tied to the user's own
 * LinkedIn account, so it has no per-account ~150/day rate limit. Used to enrich the
 * imported network with full profile context (experience, education, skills, about)
 * within minutes. Unipile stays for messaging + private data.
 *
 * Targets harvestapi/linkedin-profile-scraper: ONE profile per run, input { url }, and
 * the profile payload is nested under `element`. Parsed defensively and normalized into
 * the SAME profileData shape the profile page already renders.
 */

export function apifyConfigured(): boolean {
  return Boolean(env.APIFY_TOKEN);
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/** HarvestAPI dates are { month, year, text } objects (or "Present"); reduce to a label. */
function dateText(d: any): string | null {
  if (!d) return null;
  if (typeof d === "string") return str(d);
  if (str(d?.text)) return str(d.text);
  if (d?.year) return `${d?.month ? `${d.month} ` : ""}${d.year}`;
  return null;
}

/** The profile payload — HarvestAPI nests it under `element`. */
function element(item: any): any {
  return item?.element ?? item ?? null;
}

/**
 * Scrape a BATCH of LinkedIn profiles via the Apify actor (synchronous). The actor takes
 * { profileScraperMode, queries: [url, ...] } and returns one flat dataset item per profile.
 * Returns the raw items; match them back to contacts via apifyItemSlug.
 */
export async function fetchLinkedInProfilesRaw(urls: string[]): Promise<any[]> {
  if (!env.APIFY_TOKEN || !urls.length) return [];
  let extra: Record<string, unknown> = {};
  if (env.APIFY_ACTOR_INPUT) {
    try {
      extra = JSON.parse(env.APIFY_ACTOR_INPUT);
    } catch {
      extra = {};
    }
  }
  const input = { profileScraperMode: env.APIFY_PROFILE_MODE, [env.APIFY_URLS_FIELD]: urls, ...extra };
  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/${env.APIFY_ACTOR_ID}/run-sync-get-dataset-items?token=${encodeURIComponent(
        env.APIFY_TOKEN,
      )}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    if (!res.ok) {
      console.error(`[apify] run ${env.APIFY_ACTOR_ID} → ${res.status}`);
      return [];
    }
    const data: any = await res.json();
    return Array.isArray(data) ? data : (data?.items ?? []);
  } catch (e) {
    console.error("[apify] fetchLinkedInProfilesRaw", e);
    return [];
  }
}

/** The LinkedIn public slug for a raw dataset item (used only if matching back is needed). */
export function apifyItemSlug(item: any): string | null {
  const p = element(item);
  const id = p?.publicIdentifier ?? p?.public_identifier ?? null;
  if (id) return String(id).toLowerCase();
  const url = p?.linkedinUrl ?? p?.url ?? null;
  if (url) {
    const m = String(url).match(/\/in\/([^/?#]+)/i);
    if (m) return decodeURIComponent(m[1]).toLowerCase();
  }
  return null;
}

/** Normalize a raw Apify/HarvestAPI item into the compact shape the profile page renders. */
export function normalizeApifyProfile(item: any): Record<string, unknown> {
  const p = element(item);

  const expSrc = Array.isArray(p?.experience) ? p.experience : [];
  const experience = expSrc.slice(0, 10).map((e: any) => ({
    company: str(e?.companyName ?? e?.company),
    position: str(e?.position ?? e?.title),
    location: str(e?.location),
    start: dateText(e?.startDate),
    end: dateText(e?.endDate),
    current: e?.endDate?.text ? /present/i.test(String(e.endDate.text)) : !e?.endDate,
  }));

  const eduSrc = Array.isArray(p?.education) ? p.education : [];
  const education = eduSrc.slice(0, 6).map((e: any) => ({
    school: str(e?.title ?? e?.school ?? e?.name),
    degree: str(e?.degree),
    field: str(e?.fieldOfStudy ?? e?.field),
    start: dateText(e?.startDate),
    end: dateText(e?.endDate),
  }));

  const skills = (Array.isArray(p?.skills) ? p.skills : [])
    .map((s: any) => (typeof s === "string" ? s : str(s?.name)))
    .filter(Boolean)
    .slice(0, 18);

  const loc = p?.location;
  const location =
    typeof loc === "object" ? str(loc?.linkedinText ?? loc?.parsed?.text) : str(loc);
  const currentCompany =
    Array.isArray(p?.currentPosition) && p.currentPosition[0]?.companyName
      ? str(p.currentPosition[0].companyName)
      : null;

  return {
    experience,
    education,
    skills,
    about: str(p?.about ?? p?.summary),
    headline: str(p?.headline),
    location,
    currentCompany,
    followerCount: typeof p?.followerCount === "number" ? p.followerCount : null,
    source: "apify",
    fetchedAt: new Date().toISOString(),
  };
}
