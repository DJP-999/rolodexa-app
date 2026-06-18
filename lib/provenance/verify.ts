import type { Claim } from "@/db/schema";
import { isNews } from "@/lib/provenance/claims";

/**
 * Output-verification pass. Every line that asserts a news/event item must map
 * to a fresh, sourced claim, or it is DROPPED before sending — making
 * "never hallucinate" structural rather than a prompt instruction.
 */
export type VerifyResult = { clean: string; dropped: string[] };

const NEWS_HINT =
  /\b(announced|raised|closed|launched|promoted|joined|named|awarded|funding|round|series [a-e]|acquired|anniversary|milestone|hiring|stepping down|new role)\b/i;

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

function overlaps(line: string, claim: Claim): boolean {
  const a = tokens(line);
  const b = tokens(`${claim.value} ${claim.field}`);
  let hits = 0;
  for (const t of b) if (a.has(t)) hits++;
  return hits >= 2;
}

export function verifyBriefAgainstClaims(
  draft: string,
  freshClaims: Claim[],
  now = new Date(),
): VerifyResult {
  const lines = draft.split(/\n+/);
  const kept: string[] = [];
  const dropped: string[] = [];
  const usableClaims = freshClaims.filter((c) => isNews(c, now));

  for (const line of lines) {
    const asserts = NEWS_HINT.test(line);
    if (!asserts) {
      kept.push(line);
      continue;
    }
    const backed = usableClaims.some((c) => overlaps(line, c));
    if (backed) kept.push(line);
    else dropped.push(line.trim());
  }
  return { clean: kept.join("\n").trim(), dropped };
}
