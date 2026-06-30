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
  // Recent email/LinkedIn thread topics WITH the user — first-hand evidence of what this
  // contact actually transacts with them (e.g. "Email: Re: Discounted Lambda Cap Table Transfer").
  recentThreads?: string[] | null;
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
  // The user's own list of who they most want to reach (e.g. "family offices, LPs, secondaries
  // buyers"). These named counterparty/capital-source TYPES are direct TOP-fit targets.
  priorityConnections?: string | null;
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

  // (3a) RECENT THREADS WITH THE DEALMAKER — first-hand proof of what they actually transact
  // together. A live deal thread (cap-table transfer, allocation, SPV, fund interest) is the
  // strongest possible on-thesis signal and overrides a stale or off-thesis LinkedIn bio.
  if (c.recentThreads?.length) {
    lines.push(`[Recent threads with you] ${c.recentThreads.slice(0, 6).join(" | ").slice(0, 700)}`);
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
    "You score how relevant each professional contact is to ONE SPECIFIC user, 0.0 to 1.0, based STRICTLY on that user's own stated focus and target counterparties below. Different users have completely different focuses; grade ONLY against the one given here, and NEVER against any assumed thesis, a generic notion of 'private markets', or a strategy the user did not state.\n" +
    "THE DEALMAKER:\n" +
    `- Role: ${focus.role?.trim() || "a user building a high-value professional network"}\n` +
    `- Focus: ${focus.currentFocus?.trim() || "(not specified — grade on general professional value: senior decision-makers and the most direct, useful counterparts for their role)"}\n` +
    (focus.activeProjects?.trim() ? `- Active deals / mandates: ${focus.activeProjects.trim()}\n` : "") +
    (focus.priorityConnections?.trim()
      ? `- Priority counterparties (the TYPES of people/firms they most want to reach): ${focus.priorityConnections.trim()}\n`
      : "") +
    "EVIDENCE PRIORITY — base each score on the dossier in THIS order of authority: (1) [Recent threads with you] — what the contact and user ACTUALLY transact together (the single strongest signal); (2) the [User's CRM notes] — first-hand, authoritative for this contact's specific intent and wants; (3) the contact's [LinkedIn profile] — their real role, seniority, and trajectory; (4) the [Firm research] / [PitchBook firm intel] brief — what the current firm ACTUALLY does and the specific stage/asset class it invests in; (5) [Facets] only as supporting context. When a [LinkedIn profile] or [Firm research] fact contradicts the stored title or a generic label, TRUST the profile/research; when a live on-thesis [Recent threads with you] or [User's CRM notes] signal contradicts an off-thesis profile, TRUST the threads/notes. When firm research is present, ground the firm's strategy/stage/asset-class in it rather than guessing from the name.\n" +
    "METHOD: Reason about the contact's FIRM (its actual strategy — what it does and what it invests in, its stage/asset class, and its standing) and the person's seniority, then score how DIRECTLY they serve the user's SPECIFIC stated focus, active mandates, and priority counterparties above. Score as a GRADIENT of closeness to that stated focus — never a binary on/off. Derive the hierarchy FROM the user's stated focus, whatever it is:\n" +
    "- TOP (0.85-1.0): the most DIRECT counterparties or capital sources for the user's exact stated focus — firms/people whose core strategy or mandate IS precisely what the user brokers, raises for, buys, or sells, OR who match one of the user's stated priority-counterparty types. For a BROKER/intermediary, BOTH sides of their market are TOP: the SELLERS/originators of the exposure they handle AND the BUYERS/capital sources for it. BE DECISIVE: when a contact's firm is a bullseye for the stated focus, or clearly matches a named priority-counterparty type, score 0.93-1.0, NOT 0.8. Do not discount an obvious match into the 0.7s/0.8s for lack of fame or thin data; if the described strategy or counterparty type squarely matches, it is TOP.\n" +
    "- STRONG (0.65-0.85): adjacent players one step up- or down-stream in the same value chain, or a closely related strategy that regularly transacts with the core focus.\n" +
    "- MODERATE (0.4-0.65): same broad ecosystem but a clear step removed from the focus — useful context, slower to act, or a different sub-strategy.\n" +
    "- LOW (0.0-0.35): unrelated to the stated focus.\n" +
    "MATCH THE SPECIFIC SUB-STRATEGY, STAGE, AND ASSET CLASS — NOT A KEYWORD. A surface keyword match is NOT a fit: if the focus names a particular asset class, stage, or deal type and the contact operates in a DIFFERENT sub-strategy that merely shares a word, they are NOT top — drop them to MODERATE (or LOW if clearly off). Conversely, a firm that does NOT share the user's keywords but whose ACTUAL described strategy is a direct counterparty or capital source for the focus IS top. Distinguish stage (early vs growth/late vs buyout), asset class (equity vs credit), and deal type even when they share a label.\n" +
    "THE NOTES FIELD IS AUTHORITATIVE. The 'Notes' line is the user's own first-hand description of what this contact actually does, invests in, and wants. Weight it ABOVE the firm name, the job title, and any generic industry/firm-type label. If the notes describe a strategy a step or more removed from the focus, score to what the notes describe; if they describe a direct counterparty or capital source, score TOP, even if the firm name seems off.\n" +
    "RECENT THREADS WITH THE USER ARE DECISIVE EVIDENCE. The '[Recent threads with you]' line lists the actual email/LinkedIn subjects this contact and the user have exchanged. This is first-hand proof of what they ACTUALLY do together — it outranks the LinkedIn profile, the firm name, and any generic label. If those threads are about the user's exact stated business (whatever it is — a sale, a deal, a contract, a partnership, an order, an allocation, a hire, an introduction, a deployment), this contact is a PROVEN, ACTIVE counterpart in the user's exact focus — score them TOP (0.9-1.0) EVEN IF their LinkedIn bio looks off-focus (a different industry, an operator/founder background, or a firm with no public research). A stale or unrelated profile NEVER overrides a live, on-focus working thread. Only discount when the threads are purely personal/administrative with no business-of-the-user content.\n" +
    "When data is thin, infer conservatively from the firm's ACTUAL strategy, stage focus, and any notable HOLDINGS or LP/capital relationships shown in the dossier — not from the firm name alone, and not by defaulting to the middle. A junior person at an on-thesis firm drops one tier.\n" +
    'Return ONLY JSON {"items":[{"id":"<id>","fit":0.0,"summary":"one line: what they do / invest in","rationale":"where on the gradient and why — name the firm\'s strategy/stage focus and why it sits there relative to THIS user\'s stated focus and priority counterparties"}]}.';
  const raw = await complete({
    tier: "strong",
    system,
    messages: [{ role: "user", content: batch.map((b) => `---\n${dossier(b)}`).join("\n") }],
    maxTokens: 2400,
    temperature: 0,
  });
  const out: FitResult[] = [];
  // Only trust ids we actually sent — a strong model occasionally mangles or hallucinates the
  // echoed id (e.g. a non-hex "uuid"), which would otherwise blow up the persist UPDATE.
  const validIds = new Set(batch.map((b) => b.id));
  try {
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    for (const it of obj.items ?? []) {
      if (!it?.id || !validIds.has(String(it.id))) continue;
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
