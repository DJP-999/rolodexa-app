import { complete } from "@/lib/llm";

/** Neutral default set when we know nothing about the user yet. */
export const GENERIC_RELATIONSHIP_TYPES = ["Prospect", "Client", "Partner", "Colleague", "Friend", "Other"];

/** Normalize a user-entered or derived list: trim, dedupe, cap, ensure a catch-all. */
export function cleanRelationshipTypes(types: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of types) {
    const v = String(t ?? "").trim().slice(0, 24);
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= 8) break;
  }
  if (!out.length) return [...GENERIC_RELATIONSHIP_TYPES];
  if (!out.some((t) => /^other$/i.test(t))) out.push("Other");
  return out;
}

/**
 * Derive a SHORT, tailored set of relationship categories for the user's world from their role +
 * focus — so a salesperson gets Prospect/Customer/Champion, a recruiter Candidate/Client, an IR
 * person LP/GP, etc. Falls back to a neutral generic set when role/focus are unknown.
 */
export async function deriveRelationshipTypes(role?: string | null, focus?: string | null): Promise<string[]> {
  if (!role?.trim() && !focus?.trim()) return [...GENERIC_RELATIONSHIP_TYPES];
  try {
    const raw = await complete({
      tier: "cheap",
      system:
        "You design a SHORT set of relationship categories for a relationship CRM, tailored to ONE specific professional. " +
        "Given their role and focus, return 4-7 concise, mutually-exclusive, title-cased labels that capture the TYPES of people in THEIR network. " +
        "Examples: a salesperson → Prospect, Customer, Champion, Partner, Colleague, Other; a recruiter → Candidate, Client, Hiring Manager, Colleague, Other; " +
        "investor relations → LP, GP, Intermediary, Colleague, Other; a founder → Investor, Customer, Advisor, Hire, Partner, Other. " +
        "Always include a catch-all 'Other'. Keep each label 1-2 words. Return JSON only: {\"types\": string[]}.",
      messages: [{ role: "user", content: `Role: ${role ?? "(unknown)"}\nFocus: ${focus ?? "(unknown)"}\nReturn the category labels.` }],
      maxTokens: 120,
      temperature: 0,
    });
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    const types = Array.isArray(obj.types) ? obj.types.map((t: unknown) => String(t)) : [];
    return cleanRelationshipTypes(types);
  } catch {
    return [...GENERIC_RELATIONSHIP_TYPES];
  }
}
