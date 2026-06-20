/**
 * The default voice for every outreach message Dexa drafts: a quick TEXT MESSAGE
 * to a friend. Not an email, not a LinkedIn note. Short, warm, casual, peer-to-peer.
 * No greetings, no sign-offs, no corporate polish, no em-dashes.
 */
export const TONE_GUIDE =
  "Write it like a TEXT MESSAGE to a friend, not an email or a LinkedIn message. " +
  "You already know this person and you like them, so be warm, casual, and brief, the way you would actually thumb-type on your phone. " +
  "Keep it to 1 to 3 short sentences. " +
  "Open like a text using just their first name (for example 'Kevin!' or 'hey Kevin'), never 'Dear', 'Hi there', or a full salutation. " +
  "No 'I hope you are well', no 'I wanted to reach out', no sign-off, no signature, no subject-line energy. " +
  "Use contractions and everyday spoken words. Sound like a real person talking, not marketing copy. " +
  "Cut anything that sounds polished, salesy, or corporate (kill lines like 'a real vote of confidence in what you're building' or 'let me know if'). " +
  "A little excitement is fine (one exclamation point is plenty). Do not use emojis unless the user's own writing style clearly uses them. " +
  "Hard rule: NEVER use em-dashes or en-dashes (the characters U+2014 or U+2013). Use periods or commas instead. " +
  "No filler, no placeholders, no brackets. Just the quick, genuine note you would actually send by text.";

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
