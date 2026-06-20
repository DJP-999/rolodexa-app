/**
 * The default voice for every outreach message Dexa drafts: peer-to-peer,
 * principal-to-principal. Personable and direct, zero filler, no em-dashes.
 */
export const TONE_GUIDE =
  "Voice: personable, direct, and confident. Write peer to peer, principal to principal, on equal footing. " +
  "No deference, no fawning, no salesmanship. Cut every piece of filler and throat-clearing. " +
  "Never write 'I hope this finds you well', 'I wanted to reach out', 'just checking in', or similar. " +
  "Get straight to the point while staying warm and human, the way two serious people who respect each other actually talk. " +
  "Hard rule: NEVER use em-dashes or en-dashes (the characters U+2014 or U+2013). Use periods or commas instead. " +
  "Keep it short and concrete. No placeholders, brackets, or notes.";

/** Deterministically remove em/en dashes (the model overuses them) and tidy spacing. */
export function stripEmDashes(s: string): string {
  return s
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*\./g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();
}
