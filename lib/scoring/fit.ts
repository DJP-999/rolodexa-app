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
    "Score as a GRADIENT of closeness to the dealmaker's STATED focus above — never a binary on/off. Derive the hierarchy FROM their focus and active mandates, whatever those are:\n" +
    "- TOP (0.85-1.0): the most DIRECT counterparties or capital sources for their exact stated focus — firms/people whose core strategy or mandate IS precisely what the dealmaker brokers, raises for, or sells.\n" +
    "- STRONG (0.65-0.85): ADJACENT players that are natural neighbors of that focus — one step up- or down-stream in the same value chain, or a closely related strategy that regularly transacts with the core focus. Rank these right after the direct counterparties.\n" +
    "- MODERATE (0.4-0.65): same broad ecosystem but a clear step removed from the focus — useful context, slower to act, or a different sub-strategy.\n" +
    "- LOW (0.0-0.35): unrelated to the stated focus.\n" +
    "Reason explicitly about WHERE on this gradient each contact's firm sits relative to the focus, and place adjacent/upstream strategies ABOVE merely-same-ecosystem ones. " +
    "Illustration of the method (apply the SAME gradient logic to whatever the focus actually is, do NOT assume this example): for a pre-IPO/secondaries focus — dedicated secondary buyers and GP-led/LP secondary funds are TOP; late/growth-stage & crossover investors (Series C+, e.g. Insight Partners, Coatue — they hold maturing pre-IPO positions) and the family offices/LPs that buy that exposure are STRONG; early-stage VCs are MODERATE; buyout PE, private credit and operators are LOW.\n" +
    "A contact's stated Deal Interest or specific target names from meeting notes outweigh a generic industry label. A junior person at an on-thesis firm drops one tier.\n" +
    "Use what you KNOW about each firm — its strategy, stage focus and notable HOLDINGS (an investor in names like Anthropic, OpenAI, Databricks, SpaceX signals late-stage/pre-IPO positioning) — plus the PitchBook intel and portfolio in the dossier, to place each contact and justify it. When data is thin, infer conservatively from the firm and role rather than defaulting to the middle.\n" +
    'Return ONLY JSON {"items":[{"id":"<id>","fit":0.0,"summary":"one line: what they do / invest in","rationale":"where on the gradient and why — name the firm\'s strategy/stage focus and any notable holdings that justify its placement relative to the dealmaker\'s stated focus"}]}.';
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
