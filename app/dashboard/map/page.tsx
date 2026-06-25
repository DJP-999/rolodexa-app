import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { geocode } from "@/lib/geo/cities";
import { MapView, type MapContact } from "./MapView";

export const dynamic = "force-dynamic";

// Small deterministic offset so contacts in the same city don't stack on one pixel.
function jitter(id: string): { dlat: number; dlng: number } {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const a = ((h % 1000) / 1000) * 2 * Math.PI;
  const r = 0.012 * (0.3 + (((h >> 10) % 1000) / 1000) * 0.7);
  return { dlat: Math.sin(a) * r, dlng: Math.cos(a) * r };
}

async function getData(userId: string): Promise<{ mapped: MapContact[]; unmapped: number }> {
  try {
    const rows = await db
      .select({
        id: contacts.id,
        name: contacts.name,
        role: contacts.role,
        company: contacts.company,
        location: contacts.location,
        relationship: contacts.relationship,
        professionalFit: contacts.professionalFit,
        highValue: contacts.highValue,
        pitchbookData: contacts.pitchbookData,
      })
      .from(contacts)
      .where(eq(contacts.userId, userId))
      .orderBy(desc(contacts.highValue), desc(contacts.relevance))
      .limit(2000);

    const mapped: MapContact[] = [];
    let unmapped = 0;
    for (const r of rows) {
      const pb = (r.pitchbookData ?? {}) as Record<string, string>;
      const own = r.location?.trim() || "";
      const fallback = pb["HQ Location"] || "";
      const inferred = !own && !!fallback;
      const hit = geocode(own) ?? (fallback ? geocode(fallback) : null);
      if (!hit) {
        unmapped++;
        continue;
      }
      const { dlat, dlng } = jitter(r.id);
      mapped.push({
        id: r.id,
        name: r.name,
        role: r.role,
        company: r.company,
        relationship: r.relationship ?? "other",
        fit: r.professionalFit ?? null,
        highValue: !!r.highValue,
        lat: hit.lat + dlat,
        lng: hit.lng + dlng,
        city: hit.label,
        inferred,
      });
    }
    return { mapped, unmapped };
  } catch {
    return { mapped: [], unmapped: 0 };
  }
}

export default async function MapPage() {
  const u = await getPrimaryUser();
  const { mapped, unmapped } = u ? await getData(u.id) : { mapped: [], unmapped: 0 };

  return (
    <div className="mx-auto max-w-[1500px]">
      <div className="mb-3">
        <h1 className="text-[28px] font-bold tracking-tight">Map</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Your network by geography — for planning road shows and seeing where your relationships
          cluster. {mapped.length} contacts mapped{unmapped ? `, ${unmapped} without a usable location` : ""}.
        </p>
      </div>
      {!u ? (
        <p className="mt-8 text-sm text-muted">Connect the database to see your map.</p>
      ) : mapped.length === 0 ? (
        <p className="mt-8 text-sm text-muted">
          No mappable contacts yet — add locations to your contacts (or import PitchBook firm HQs) and
          they&apos;ll appear here.
        </p>
      ) : (
        <MapView contacts={mapped} unmapped={unmapped} />
      )}
    </div>
  );
}
