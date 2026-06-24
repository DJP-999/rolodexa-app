/**
 * Entity matching for news provenance. The whole point is precision: we must NOT
 * attach an article about a different person or a similarly-named firm to a contact.
 * A shared single token ("Ion" in "Ion Pacific" vs "Ion Video") is never a match —
 * we require the contact's FULL firm phrase (word-bounded) or their full name.
 */

const TITLES = new Set([
  "dr", "mr", "mrs", "ms", "prof", "jr", "sr", "ii", "iii", "iv", "phd", "cfa", "mba", "esq",
]);

const LEGAL_SUFFIX =
  /\s+(llc|inc|incorporated|ltd|limited|llp|lp|plc|corp|corporation|co|gmbh|ag|sa|pte|pty|bv|nv)$/;

/** Lowercase, strip accents, collapse any non-alphanumeric run to a single space. */
export function flatten(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "first last" (drops honorifics/suffixes); single token if only one name part. */
export function nameKey(name: string): string {
  const t = flatten(name)
    .split(" ")
    .filter((w) => w && !TITLES.has(w));
  if (!t.length) return "";
  if (t.length === 1) return t[0];
  return `${t[0]} ${t[t.length - 1]}`;
}

/** Distinctive, comparable form of a firm name: flattened, trailing legal suffixes removed. */
export function firmPhrase(company?: string | null): string {
  if (!company) return "";
  let s = flatten(company);
  let prev: string;
  do {
    prev = s;
    s = s.replace(LEGAL_SUFFIX, "").trim();
  } while (s !== prev);
  return s;
}

/**
 * True only when `text` plausibly references THIS contact: their exact firm phrase
 * (≥2 words, or a single distinctive ≥7-char token) appearing word-bounded, OR their
 * full name (first AND last present, or the "first last" key). Deliberately strict —
 * we would rather miss a real item than attach the wrong firm's news.
 */
export function mentionsContact(c: { name?: string | null; company?: string | null }, text: string): boolean {
  const hay = ` ${flatten(text || "")} `;
  if (hay.trim().length === 0) return false;

  const firm = firmPhrase(c.company);
  if (firm) {
    const tokens = firm.split(" ").filter(Boolean);
    const distinct = tokens.length >= 2 || firm.length >= 7;
    if (distinct && hay.includes(` ${firm} `)) return true;
  }

  const key = nameKey(c.name ?? "");
  const parts = key.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (first.length >= 2 && last.length >= 3 && hay.includes(` ${first} `) && hay.includes(` ${last} `)) {
      return true;
    }
    if (hay.includes(` ${key} `)) return true;
  } else if (parts.length === 1 && parts[0].length >= 5) {
    if (hay.includes(` ${parts[0]} `)) return true;
  }

  return false;
}
