import { complete } from "@/lib/llm";
import type { contacts } from "@/db/schema";

type Contact = typeof contacts.$inferSelect;

export type IntroMatch = {
  toContactId: string;
  toName: string;
  toLinkedin: string | null;
  reason: string;
  basis: string;
  score: number;
};

const STOP = new Set([
  "with", "that", "this", "from", "they", "have", "into", "about", "their", "there", "also", "just",
  "like", "really", "very", "more", "some", "what", "when", "where", "which", "were", "been", "being",
  "does", "doing", "work", "working", "company", "firm", "group", "based", "team", "looking", "build",
]);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

function personal(c: Contact): { interests: string[]; city: string } {
  const pp = (c.personalProfile ?? {}) as { interests?: string[]; currentCity?: string | null; hometown?: string | null };
  const loc = pp.currentCity || c.location || pp.hometown || "";
  return { interests: Array.isArray(pp.interests) ? pp.interests : [], city: norm(loc).split(" ").slice(0, 2).join(" ") };
}

function notesOf(c: Contact): string {
  const cf = (c.customFields ?? {}) as Record<string, string>;
  const key = Object.keys(cf).find((k) => /note|background|summary|description|comment|bio|about/i.test(k));
  return [cf["Meeting Notes"], key ? cf[key] : "", c.summary ?? ""].filter(Boolean).join(" ").slice(0, 400);
}

function tokens(c: Contact, extra = ""): Set<string> {
  const hay = norm(
    [c.role, c.company, c.industry, personal(c).interests.join(" "), notesOf(c), extra].filter(Boolean).join(" "),
  );
  return new Set(hay.split(" ").filter((w) => w.length > 3 && !STOP.has(w)));
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/**
 * Suggest mutual introductions for contact `a` (the person just met) from the rest of the network.
 * Deterministic prefilter scores shared industry/interest/keywords PLUS proximity (same city/metro),
 * then one cheap LLM call ranks the genuinely worthwhile, mutual-benefit pairs with a reason.
 */
export async function findIntros(a: Contact, candidates: Contact[], aNote = "", max = 3): Promise<IntroMatch[]> {
  const aTok = tokens(a, aNote);
  const aPers = personal(a);
  const aInd = norm(a.industry ?? "");

  const scored = candidates
    .filter((c) => c.id !== a.id && !c.isOrganization && (c.relevance ?? 0) >= 20 && (c.role || c.company || c.industry))
    .map((c) => {
      const ov = overlap(aTok, tokens(c));
      const indMatch = aInd && norm(c.industry ?? "") === aInd ? 3 : 0;
      const sameCity = !!aPers.city && personal(c).city === aPers.city;
      return { c, s: ov + indMatch + (sameCity ? 2 : 0), sameCity };
    })
    .filter((x) => x.s >= 2)
    .sort((x, y) => y.s - x.s)
    .slice(0, 25);
  if (!scored.length) return [];

  const aProfile = {
    name: a.name, role: a.role, company: a.company, industry: a.industry, location: a.location,
    interests: aPers.interests, notes: (aNote || notesOf(a)).slice(0, 400),
  };
  const cands = scored.map(({ c, sameCity }) => ({
    id: c.id, name: c.name, role: c.role, company: c.company, industry: c.industry,
    location: c.location, interests: personal(c).interests, sameArea: sameCity,
  }));

  const raw = await complete({
    tier: "cheap",
    system:
      "You suggest MUTUAL INTRODUCTIONS for a relationship-focused professional. Given a person they just met and a list of other people they know, pick the ones the user should INTRODUCE to the met person — ONLY pairs that would GENUINELY benefit from knowing each other: a shared industry / market / interest, complementary needs (e.g. a buyer and a seller, an operator and an investor), or being in the same city/area. Skip weak or generic matches; quality over quantity. " +
      'Return JSON only: {"intros":[{"id":"<candidate id>","reason":"one line naming the concrete mutual benefit and any shared market or area"}]}.',
    messages: [
      {
        role: "user",
        content: `Just met:\n${JSON.stringify(aProfile)}\n\nPeople they know (candidates):\n${JSON.stringify(cands)}\n\nReturn up to ${max} strong intros.`,
      },
    ],
    maxTokens: 500,
    temperature: 0.2,
  });

  try {
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    const byId = new Map(scored.map((x) => [x.c.id, x]));
    const out: IntroMatch[] = [];
    for (const it of obj.intros ?? []) {
      const hit = byId.get(String(it?.id));
      if (!hit || !it?.reason) continue;
      const basis: string[] = [];
      if (hit.sameCity && a.location) basis.push(`same area: ${a.location}`);
      out.push({
        toContactId: hit.c.id,
        toName: hit.c.name,
        toLinkedin: hit.c.linkedinUrl ?? null,
        reason: String(it.reason).slice(0, 240),
        basis: basis.join("; "),
        score: Math.min(1, hit.s / 10),
      });
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  }
}
