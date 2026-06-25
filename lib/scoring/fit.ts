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
    "You score how relevant each professional contact is to a specific dealmaker, 0.0 to 1.0, based STRICTLY on the dealmaker's stated focus below — NOT on generic 'private markets' adjacency.\n" +
    "THE DEALMAKER:\n" +
    `- Role: ${focus.role ?? "placement agent / dealmaker in private markets"}\n` +
    `- Focus: ${focus.currentFocus ?? "brokering secondaries and raising capital from allocators and family offices"}\n` +
    (focus.activeProjects ? `- Active deals / mandates: ${focus.activeProjects}\n` : "") +
    "Reason about the contact's FIRM (its strategy — what it does and what it invests in — and its standing) and the person's seniority, then score how DIRECTLY they serve the dealmaker's SPECIFIC stated focus and active mandates above.\n" +
    "HIGH (0.8-1.0): a direct, on-thesis counterparty or capital source for the stated focus — their firm's strategy and mandate clearly match what the dealmaker is brokering or raising for, and they are senior enough to act. (For a VC-secondaries focus, that means secondaries buyers/funds, GP-led & LP secondaries investors, and the family offices / RIAs / LPs / allocators who back or buy that exposure.)\n" +
    "MEDIUM (0.4-0.7): plausibly useful but NOT directly on-thesis — an investor in a DIFFERENT strategy, a service provider, an adjacent operator, or a junior person at an otherwise on-thesis firm.\n" +
    "LOW (0.0-0.3): unrelated to the stated focus.\n" +
    "CRITICAL: do NOT score an off-thesis firm HIGH just because it is in private markets. If the focus is VC secondaries, then a control/buyout or lower-middle-market PE fund, an unrelated VC, a private-credit shop, or an operating company is MEDIUM at best — not high. Tie every score to the SPECIFIC stated focus and mandates.\n" +
    "Use what you know about named firms. When data is thin, infer conservatively from the firm and role rather than defaulting to the middle.\n" +
    'Return ONLY JSON {"items":[{"id":"<id>","fit":0.0,"summary":"one line: what they do / invest in","rationale":"why this score, naming the firm and how its strategy relates to the stated focus"}]}.';
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
