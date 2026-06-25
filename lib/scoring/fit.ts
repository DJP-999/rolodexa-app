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
  pitchbook?: Record<string, string> | null;
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
  if (c.pitchbook && Object.keys(c.pitchbook).length) {
    const pb = Object.entries(c.pitchbook)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ");
    if (pb) lines.push(`PitchBook firm intel: ${pb}`);
  }
  return lines.join("\n");
}

export async function gradeFitBatch(batch: FitInput[], focus: UserFocus): Promise<FitResult[]> {
  if (!batch.length) return [];
  const system =
    "You score how relevant each professional contact is to a specific dealmaker, 0.0 to 1.0, based STRICTLY on the dealmaker's stated focus below — NOT on generic 'private markets' adjacency.\n" +
    "THE DEALMAKER:\n" +
    `- Role: ${focus.role ?? "placement agent / dealmaker in private markets"}\n` +
    `- Focus: ${focus.currentFocus ?? "brokering secondaries and raising capital from allocators and family offices"}\n` +
    (focus.activeProjects ? `- Active deals / mandates: ${focus.activeProjects}\n` : "") +
    "Reason about the contact's FIRM (its strategy — what it does and what it invests in — and its standing) and the person's seniority, then score how DIRECTLY they serve the dealmaker's SPECIFIC stated focus and active mandates above.\n" +
    "Score on a HIERARCHY of closeness to a PRE-IPO SECONDARIES / late-stage private thesis — a GRADIENT, never a binary on/off:\n" +
    "TIER 1 — Explicit secondaries (0.9-1.0): the firm's strategy IS secondaries — dedicated secondary buyers, GP-led & LP secondary funds, direct-secondary vehicles, continuation funds — or a contact whose stated Deal Interest is Secondaries. The closest possible counterparties.\n" +
    "TIER 2 — Late / growth-stage venture & crossover (0.72-0.9): growth-equity, late-stage venture, Series C+ and pre-IPO crossover investors (e.g. Insight Partners, Coatue, Tiger Global, Dragoneer, growth arms of large funds). They hold maturing pre-IPO positions, so they are natural buyers AND sellers of secondaries and late-stage directs — rank them RIGHT AFTER explicit secondaries. The capital allocators (family offices, RIAs, LPs, sovereigns, fund-of-funds) that fund or buy late-stage / secondary exposure also belong in this tier.\n" +
    "TIER 3 — Early-stage venture (0.45-0.68): seed and Series A/B VCs — on-ecosystem and may become sellers as positions mature, but earlier in the lifecycle and less immediately actionable.\n" +
    "TIER 4 — Everyone else (0.0-0.35): control/buyout PE, lower-middle-market PE, private credit, real assets, operating companies, service providers, and anything unrelated to venture/secondaries.\n" +
    "A contact's stated Deal Interest, or specific pre-IPO target names from meeting notes, outweighs a generic 'Venture Capital' label. A junior person at an on-thesis firm drops one tier.\n" +
    "Use what you actually KNOW about the firm — its stage focus and notable HOLDINGS (an investor in names like Anthropic, OpenAI, Databricks, SpaceX, Stripe is clearly late-stage/pre-IPO and belongs in Tier 2, e.g. Insight Partners holds Anthropic) — together with the PitchBook intel and portfolio in the dossier, to place each contact in the right tier. When data is thin, infer conservatively from the firm and role rather than defaulting to the middle.\n" +
    'Return ONLY JSON {"items":[{"id":"<id>","fit":0.0,"summary":"one line: what they do / invest in","rationale":"which tier and why — name the firm\'s stage focus and any notable holdings (e.g. an investor in Anthropic) that justify the placement relative to secondaries / late-stage venture"}]}.';
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
