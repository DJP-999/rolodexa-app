/**
 * The default voice for every outreach message Dexa drafts: friendly, casual, and
 * peer-to-peer. You already know these people, so it reads like a note to a friend,
 * not a formal email. No filler, no em-dashes.
 */
export const TONE_GUIDE =
  "Voice: warm, friendly, and casual, the way you write to someone you already know and genuinely like. " +
  "You two are peers with real rapport, so drop all formality and pleasantries. No 'Dear', no 'I hope you are well', no corporate or salesy phrasing, no throat-clearing. " +
  "Write like a quick, real note to a friend in your world: relaxed, direct, human, with contractions and plain words. A little warmth and personality is good. " +
  "Get to the point in a friendly way, and cut every piece of filler. " +
  "Hard rule: NEVER use em-dashes or en-dashes (the characters U+2014 or U+2013). Use periods or commas instead. " +
  "Keep it short. No placeholders, brackets, or notes.";

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
