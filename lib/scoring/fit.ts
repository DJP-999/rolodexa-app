import { complete } from "@/lib/llm";

/**
 * LLM domain-fit grading. Evaluates how relevant a contact is to THIS user's deal
 * business by reasoning about the person AND their firm (what it does, what it
 * invests in, its standing), against the user's stated focus. Produces a 0..1 fit
 * score plus a short "what they do/invest in" summary and a rationale.
 *
 * Deliberately fed from ALL available signal (role, firm, headline, notes, derived
 * facets, and the deep LinkedIn profile when present), so a prominent secondaries
 * investor ranks high even if their stored title is just "Partner".
 */

export type FitInput = {
  id: string;
  name: string;
  role?: string | null;
  company?: string | null;
  industry?: string | null;
  location?: string | null;
  relationship?: string | null;
  notes?: string | null;
  derived?: Record<string, string | undefined>;
  profile?: {
    headline?: string | null;
    about?: string | null;
    experience?: Array<{ title?: string; position?: string; company?: string }> | null;
    skills?: string[] | null;
  } | null;
};

export type UserFocus = {
  role?: string | null;
  currentFocus?: string | null;
  activeProjects?: string | null;
};

export type FitResult = { id: string; fit: number; summary: string; rationale: string };

function dossier(c: FitInput): string {
  const lines: string[] = [`id: ${c.id}`, `Name: ${c.name}`];
  if (c.role) lines.push(`Role: ${c.role}`);
  if (c.company) lines.push(`Firm: ${c.company}`);
  if (c.profile?.headline) lines.push(`Headline: ${c.profile.headline}`);
  if (c.industry) lines.push(`Industry: ${c.industry}`);
  if (c.location) lines.push(`Location: ${c.location}`);
  if (c.relationship) lines.push(`Relationship: ${c.relationship}`);
  if (c.derived) {
    const d = Object.entries(c.derived)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`);
    if (d.length) lines.push(d.join("; "));
  }
  if (c.profile?.about) lines.push(`About: ${String(c.profile.about).slice(0, 500)}`);
  if (c.profile?.experience?.length) {
    const ex = c.profile.experience
      .slice(0, 4)
      .map((e) => `${e.title || e.position || ""} @ ${e.company || ""}`.replace(/ @ $/, "").trim())
      .filter(Boolean);
    if (ex.length) lines.push(`Experience: ${ex.join("; ")}`);
  }
  if (c.profile?.skills?.length) lines.push(`Skills: ${c.profile.skills.slice(0, 10).join(", ")}`);
  if (c.notes) lines.push(`Notes: ${c.notes.slice(0, 400)}`);
  return lines.join("\n");
}

export async function gradeFitBatch(batch: FitInput[], focus: UserFocus): Promise<FitResult[]> {
  if (!batch.length) return [];
  const system =
    "You score how relevant each professional contact is to a specific dealmaker, 0.0 to 1.0.\n" +
    "THE DEALMAKER:\n" +
    `- Role: ${focus.role ?? "placement agent / dealmaker in private markets"}\n` +
    `- Focus: ${focus.currentFocus ?? "brokering pre-IPO secondaries and raising capital for lower-middle-market buyouts; relationship-first work with capital allocators and family offices"}\n` +
    (focus.activeProjects ? `- Active deals: ${focus.activeProjects}\n` : "") +
    "Score by DOMAIN/THESIS FIT and how valuable the relationship is to THIS dealmaker. Reason explicitly about the contact's FIRM — what it does, what it invests in, and its standing — and the person's seniority.\n" +
    "HIGH (0.8-1.0): senior/prominent people at secondaries firms (GP-led & LP secondaries), fund-of-funds, large family offices and other capital allocators, LPs, PE/growth investors active in secondaries or LMM buyouts, secondaries/placement advisors, and well-known check-writers aligned with this focus.\n" +
    "MEDIUM (0.4-0.7): adjacent private-markets professionals (VCs, investment bankers, fund lawyers, founders) with plausible relevance.\n" +
    "LOW (0.0-0.3): unrelated fields, no signal of relevance, or clearly off-thesis.\n" +
    "Use what you know about NAMED firms (e.g. major secondaries and PE shops). When data is thin, infer conservatively from the firm and role rather than defaulting to the middle.\n" +
    'Return ONLY JSON {"items":[{"id":"<id>","fit":0.0,"summary":"one line: what they do / invest in","rationale":"why this score, naming the firm and thesis"}]}.';
  const raw = await complete({
    tier: "cheap",
    system,
    messages: [{ role: "user", content: batch.map((b) => `---\n${dossier(b)}`).join("\n") }],
    maxTokens: 1800,
    temperature: 0,
  });
  const out: FitResult[] = [];
  try {
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    for (const it of obj.items ?? []) {
      if (!it?.id) continue;
      let fit = Number(it.fit);
      if (!isFinite(fit)) fit = 0.4;
      fit = Math.max(0, Math.min(1, fit));
      out.push({
        id: String(it.id),
        fit,
        summary: String(it.summary ?? "").slice(0, 240),
        rationale: String(it.rationale ?? "").slice(0, 300),
      });
    }
  } catch {
    /* skip bad batch */
  }
  return out;
}
