import { env } from "@/lib/env";

/**
 * Apify adapter — bulk LinkedIn profile enrichment that is NOT tied to the user's own
 * LinkedIn account, so it has no per-account ~150/day rate limit. Used to enrich the
 * whole imported network with full profile context (experience, education, skills,
 * about) within minutes of import. Unipile stays for messaging + private data.
 *
 * Output shapes vary by actor, so everything is parsed defensively at the boundary and
 * normalized into the SAME profileData shape the profile page already renders.
 */

export function apifyConfigured(): boolean {
  return Boolean(env.APIFY_TOKEN);
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/** Run a LinkedIn profile actor synchronously for a batch of profile URLs; returns raw dataset items. */
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
  const input = { ...extra, [env.APIFY_URLS_FIELD]: urls };
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

/** The LinkedIn public slug for one raw dataset item, used to match results back to a contact. */
export function apifyItemSlug(p: any): string | null {
  const id = p?.publicIdentifier ?? p?.public_identifier ?? p?.username ?? p?.slug ?? null;
  if (id) return String(id).toLowerCase();
  const url =
    p?.linkedinUrl ?? p?.url ?? p?.profileUrl ?? p?.profile_url ?? p?.inputUrl ?? p?.input?.url ?? null;
  if (url) {
    const m = String(url).match(/\/in\/([^/?#]+)/i);
    if (m) return decodeURIComponent(m[1]).toLowerCase();
  }
  return null;
}

/** Normalize a raw Apify profile item into the compact shape the profile page renders. */
export function normalizeApifyProfile(p: any): Record<string, unknown> {
  const expSrc = p?.experience ?? p?.experiences ?? p?.work_experience ?? p?.positions ?? [];
  const experience = (Array.isArray(expSrc) ? expSrc : []).slice(0, 10).map((e: any) => ({
    company: str(e?.companyName ?? e?.company ?? e?.organisation ?? e?.org ?? e?.company_name),
    position: str(e?.title ?? e?.position ?? e?.role ?? e?.jobTitle),
    location: str(e?.location ?? e?.locationName ?? e?.geoLocationName),
    start: str(e?.startDate ?? e?.start ?? e?.starts_at ?? e?.dateRange?.start ?? e?.duration?.start),
    end: str(e?.endDate ?? e?.end ?? e?.ends_at ?? e?.dateRange?.end ?? e?.duration?.end),
    current: Boolean(e?.current ?? e?.isCurrent ?? (!(e?.endDate ?? e?.end ?? e?.ends_at))),
  }));

  const eduSrc = p?.education ?? p?.educations ?? p?.schools ?? [];
  const education = (Array.isArray(eduSrc) ? eduSrc : []).slice(0, 6).map((e: any) => ({
    school: str(e?.schoolName ?? e?.school ?? e?.name ?? e?.title ?? e?.institution),
    degree: str(e?.degree ?? e?.degreeName),
    field: str(e?.fieldOfStudy ?? e?.field_of_study ?? e?.field),
    start: str(e?.startDate ?? e?.start),
    end: str(e?.endDate ?? e?.end),
  }));

  const skillsSrc = p?.skills ?? [];
  const skills = (Array.isArray(skillsSrc) ? skillsSrc : [])
    .map((s: any) => (typeof s === "string" ? s : str(s?.name ?? s?.title)))
    .filter(Boolean)
    .slice(0, 18);

  const locRaw = p?.location ?? p?.locationName ?? p?.geoLocationName ?? p?.geo?.full ?? null;
  const location = typeof locRaw === "object" ? str(locRaw?.name ?? locRaw?.full) : str(locRaw);

  return {
    experience,
    education,
    skills,
    about: str(p?.about ?? p?.summary ?? p?.description),
    headline: str(p?.headline ?? p?.occupation ?? p?.subTitle ?? p?.sub_title),
    location,
    followerCount: typeof p?.followerCount === "number" ? p.followerCount : null,
    source: "apify",
    fetchedAt: new Date().toISOString(),
  };
}
