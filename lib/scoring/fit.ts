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
  // Web-sourced brief on the contact's CURRENT firm (lib/research/firm.ts). Primary, objective
  // evidence for what the firm actually does and invests in.
  firmResearch?: string | null;
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
  // Ordered by EVIDENCE PRIORITY: identity → LinkedIn profile → firm research → firm intel →
  // the user's own CRM notes → supporting facets. The grader is told to weight them in this order.
  const lines: string[] = [`id: ${c.id}`, `Name: ${c.name}`];
  if (c.role) lines.push(`Stored title: ${c.role}`);
  if (c.company) lines.push(`Current firm: ${c.company}`);

  // (1) LINKEDIN PROFILE — the person's real role, seniority, and trajectory.
  const prof: string[] = [];
  if (c.profile?.headline) prof.push(`Headline: ${c.profile.headline}`);
  if (c.profile?.about) prof.push(`About: ${String(c.profile.about).slice(0, 600)}`);
  if (c.profile?.experience?.length) {
    const ex = c.profile.experience
      .slice(0, 5)
      .map((e) => `${e.title || e.position || ""} @ ${e.company || ""}`.replace(/ @ $/, "").trim())
      .filter(Boolean);
    if (ex.length) prof.push(`Experience: ${ex.join("; ")}`);
  }
  if (c.profile?.skills?.length) prof.push(`Skills: ${c.profile.skills.slice(0, 10).join(", ")}`);
  if (prof.length) lines.push(`[LinkedIn profile]\n${prof.join("\n")}`);

  // (2) FIRM RESEARCH — web-sourced brief on what the current firm actually does/invests in.
  if (c.firmResearch) lines.push(`[Firm research — ${c.company ?? "current firm"}]\n${c.firmResearch.slice(0, 1400)}`);
  if (c.pitchbook && Object.keys(c.pitchbook).length) {
    const pb = Object.entries(c.pitchbook)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ");
    if (pb) lines.push(`[PitchBook firm intel] ${pb}`);
  }

  // (3) USER CRM NOTES — authoritative for this contact's specific intent and wants.
  if (c.notes) lines.push(`[User's CRM notes] ${c.notes.slice(0, 500)}`);

  // (4) Supporting facets.
  const facets: string[] = [];
  if (c.industry) facets.push(`Industry: ${c.industry}`);
  if (c.location) facets.push(`Location: ${c.location}`);
  if (c.relationship) facets.push(`Relationship: ${c.relationship}`);
  if (c.derived) {
    const d = Object.entries(c.derived)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`);
    if (d.length) facets.push(d.join("; "));
  }
  if (facets.length) lines.push(`[Facets] ${facets.join("; ")}`);

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
    "EVIDENCE PRIORITY — base each score on the dossier in THIS order of authority: (1) the contact's [LinkedIn profile] — their real role, seniority, and trajectory; (2) the [Firm research] / [PitchBook firm intel] brief — what the current firm ACTUALLY does and the specific stage/asset class it invests in; (3) the [User's CRM notes] — first-hand, authoritative for this contact's specific intent and what they want; (4) [Facets] only as supporting context. When a [LinkedIn profile] or [Firm research] fact contradicts the stored title or a generic label, TRUST the profile/research. When firm research is present, ground the firm's strategy/stage/asset-class in it rather than guessing from the name.\n" +
    "Reason about the contact's FIRM (its strategy — what it does and what it invests in — and its standing) and the person's seniority, then score how DIRECTLY they serve the dealmaker's SPECIFIC stated focus and active mandates above.\n" +
    "Score as a GRADIENT of closeness to the dealmaker's STATED focus above — never a binary on/off. Derive the hierarchy FROM their focus and active mandates, whatever those are:\n" +
    "- TOP (0.85-1.0): the most DIRECT counterparties or capital sources for their exact stated focus — firms/people whose core strategy or mandate IS precisely what the dealmaker brokers, raises for, or sells. BE DECISIVE HERE: when a contact's firm is a BULLSEYE — its core, dedicated strategy IS the dealmaker's exact focus (e.g. a fund dedicated to VC / pre-IPO secondaries for a VC-secondaries dealmaker), or it is a direct capital source for the dealmaker's raises (a family office, fund-of-funds, or LP that buys exactly the exposure the dealmaker sells) — score it 0.93-1.0, NOT 0.8. Do not discount an obvious exact match into the 0.7s/0.8s for lack of fame or thin data; if the firm's described strategy squarely matches the focus, it is TOP.\n" +
    "- STRONG (0.65-0.85): ADJACENT players that are natural neighbors of that focus — one step up- or down-stream in the same value chain, or a closely related strategy that regularly transacts with the core focus. Rank these right after the direct counterparties.\n" +
    "- MODERATE (0.4-0.65): same broad ecosystem but a clear step removed from the focus — useful context, slower to act, or a different sub-strategy.\n" +
    "- LOW (0.0-0.35): unrelated to the stated focus.\n" +
    "Reason explicitly about WHERE on this gradient each contact's firm sits relative to the focus, and place adjacent/upstream strategies ABOVE merely-same-ecosystem ones. " +
    "MATCH THE SPECIFIC SUB-STRATEGY AND ASSET CLASS, NOT THE LABEL. A surface keyword match is NOT a fit: if the dealmaker's focus names a particular asset class, stage, or deal type and the contact operates in a DIFFERENT sub-strategy that merely shares a word, they are NOT TOP — drop them to MODERATE (or LOW if clearly off). Reserve TOP only for contacts whose ACTUAL described focus is the dealmaker's ACTUAL described focus. Concretely: 'secondaries' is not one thing — venture/pre-IPO direct & VC GP-led secondaries are a DIFFERENT asset class from PE/buyout-fund LP-stake or GP-led secondaries; a buyout-fund secondaries shop is NOT a top match for a pre-IPO/venture-secondaries focus, and vice versa. The same applies to stage (early vs late/growth vs buyout), asset class (equity vs credit), and deal type.\n" +
    "THE NOTES FIELD IS AUTHORITATIVE. The 'Notes' line is the dealmaker's own first-hand description of what this contact actually does, invests in, and wants. Weight it ABOVE the firm name, the job title, and any generic industry/firm-type label. If the notes say the contact is focused on PE/buyout, large-cap, private credit, or any strategy a step or more removed from the dealmaker's stated focus, score to what the notes describe — do not inflate them because the firm name or title sounds on-thesis.\n" +
    "Illustration of the method (apply the SAME gradient logic to whatever the focus actually is, do NOT assume this example): for a pre-IPO / venture-secondaries focus — buyers/sellers of DIRECT late-stage startup positions and pre-IPO/VC GP-led secondaries are TOP; late/growth-stage & crossover investors (Series C+, e.g. Insight Partners, Coatue — they hold maturing pre-IPO positions) and the family offices/LPs that buy that exposure are STRONG; early-stage VCs are MODERATE; PE/buyout-fund secondaries (a different underlying asset class), large-cap buyout PE, private credit and operators are LOW-to-MODERATE even though some carry the word 'secondaries' or 'private equity'.\n" +
    "A contact's stated Deal Interest, Notes, or specific target names outweigh a generic industry label. A junior person at an on-thesis firm drops one tier.\n" +
    "Use what you KNOW about each firm — its strategy, stage focus and notable HOLDINGS (an investor in names like Anthropic, OpenAI, Databricks, SpaceX signals late-stage/pre-IPO positioning) — plus the PitchBook intel and portfolio in the dossier, to place each contact and justify it. When data is thin, infer conservatively from the firm and role rather than defaulting to the middle.\n" +
    'Return ONLY JSON {"items":[{"id":"<id>","fit":0.0,"summary":"one line: what they do / invest in","rationale":"where on the gradient and why — name the firm\'s strategy/stage focus and any notable holdings that justify its placement relative to the dealmaker\'s stated focus"}]}.';
  const raw = await complete({
    tier: "strong",
    system,
    messages: [{ role: "user", content: batch.map((b) => `---\n${dossier(b)}`).join("\n") }],
    maxTokens: 2400,
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
