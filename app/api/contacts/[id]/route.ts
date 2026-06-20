import { NextResponse } from "next/server";
import { getContactProfile } from "@/lib/contactProfile";

export const dynamic = "force-dynamic";

/** Condensed contact summary for the contacts-list dropdown. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await getContactProfile(id);
  if (!p) return NextResponse.json({ ok: false }, { status: 404 });
  const { contact: c, stats, claims: cls, bio } = p;
  return NextResponse.json({
    ok: true,
    name: c.name,
    role: c.role,
    company: c.company,
    industry: c.industry,
    location: c.location,
    relationship: c.relationship,
    relevance: c.relevance,
    lastContactedAt: c.lastContactedAt,
    bio,
    stats,
    recentNews: cls
      .filter((x) => x.field === "news" || x.field === "job_change")
      .slice(0, 3)
      .map((x) => ({ value: x.value, url: x.sourceUrl, date: x.eventDate })),
  });
}
