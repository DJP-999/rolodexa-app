import { complete } from "@/lib/llm";
import type { contacts } from "@/db/schema";

type Contact = typeof contacts.$inferSelect;

/** The personal knowledge we keep per contact to power genuine, well-timed outreach. */
export type PersonalProfile = {
  schools: string[];
  currentCity: string | null;
  hometown: string | null;
  roleStartDate: string | null; // ISO yyyy-mm-dd — anchors the work anniversary
  birthday: string | null; // "MM-DD"
  interests: string[];
  teams: string[]; // reserved — derived from schools/city at event-match time
  extractedAt: string;
};

const uniq = (xs: (string | null | undefined)[]): string[] =>
  Array.from(new Set(xs.map((s) => (s ?? "").trim()).filter(Boolean)));

/** Parse a rough LinkedIn date ("Apr 2026", "2024", "Present") to a Date, else null. */
function parseRough(s?: string | null): Date | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  if (/present/i.test(t)) return new Date();
  const m = t.match(/([A-Za-z]{3,})?\s*(\d{4})/);
  if (!m) return null;
  const year = Number(m[2]);
  if (!year) return null;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const mi = m[1] ? months.findIndex((mo) => m[1]!.toLowerCase().startsWith(mo)) : 0;
  return new Date(year, mi < 0 ? 0 : mi, 1);
}

const toISO = (d: Date | null): string | null => (d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null);

/** Pull a birthday ("MM-DD") out of imported custom fields, if a birthday column exists. */
function birthdayFromFields(cf: Record<string, string>): string | null {
  const key = Object.keys(cf).find((k) => /birth|b-?day|^dob$|date of birth/i.test(k));
  if (!key) return null;
  const raw = (cf[key] ?? "").trim();
  if (!raw) return null;
  // Accept "1985-04-12", "4/12/1985", "April 12", "12 Apr", etc. We only keep month-day.
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  let mo: number | null = null;
  let day: number | null = null;
  const iso = raw.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  const slash = raw.match(/\b(\d{1,2})[/.](\d{1,2})(?:[/.]\d{2,4})?\b/);
  const named = raw.match(/([A-Za-z]{3,})\s+(\d{1,2})|(\d{1,2})\s+([A-Za-z]{3,})/);
  if (iso) {
    mo = Number(iso[2]);
    day = Number(iso[3]);
  } else if (named) {
    const name = (named[1] ?? named[4] ?? "").toLowerCase();
    mo = months.findIndex((m) => name.startsWith(m)) + 1 || null;
    day = Number(named[2] ?? named[3]);
  } else if (slash) {
    mo = Number(slash[1]);
    day = Number(slash[2]);
  }
  if (!mo || !day || mo < 1 || mo > 12 || day < 1 || day > 31) return null;
  return `${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Build a contact's personal profile. Deterministic fields (schools, city, role-start, birthday)
 * are parsed directly; interests + a hometown hint come from one CHEAP LLM read of the LinkedIn
 * "about" + skills + a few of your real conversation snippets — so cost is bounded and the LLM is
 * only spent when there's actual personal text to read.
 */
export async function extractPersonalProfile(c: Contact, conversation: string[] = []): Promise<PersonalProfile> {
  const pd = (c.profileData ?? {}) as {
    education?: Array<{ school?: string | null; name?: string | null }>;
    experience?: Array<{ company?: string | null; current?: boolean; start?: string | null }>;
    about?: string | null;
    skills?: string[] | null;
    location?: string | null;
  };

  const schools = uniq((pd.education ?? []).map((e) => e?.school || e?.name)).slice(0, 4);
  const currentCity = (typeof pd.location === "string" && pd.location.trim()) || c.location || null;
  const exp = Array.isArray(pd.experience) ? pd.experience : [];
  const cur = exp.find((e) => e?.current) ?? exp[0];
  const roleStartDate = toISO(parseRough(cur?.start));
  const birthday = birthdayFromFields((c.customFields ?? {}) as Record<string, string>);

  let interests: string[] = [];
  let hometown: string | null = null;

  const about = typeof pd.about === "string" ? pd.about.slice(0, 1200) : "";
  const skills = Array.isArray(pd.skills) ? pd.skills.slice(0, 15) : [];
  const convo = conversation.filter(Boolean).slice(0, 8).join("\n").slice(0, 1500);
  const hasText = about.length > 40 || convo.length > 40;

  if (hasText) {
    try {
      const raw = await complete({
        tier: "cheap",
        system:
          "You extract a professional contact's PERSONAL interests for a relationship CRM (so the user can reach out about things the contact actually cares about). From the bio, skills, and message snippets, list genuine personal interests, hobbies, causes, sports, or passions (e.g. 'marathon running', 'Notre Dame football', 'wine', 'climate philanthropy', 'fly fishing'). " +
          "Also extract HOMETOWN — the city/metro where they GREW UP or went to HIGH SCHOOL (their true rooting interest), only if it's stated or strongly implied, and ONLY when it's distinct from where they currently work. Return just the city (and state if given), e.g. 'Miami' or 'Pittsburgh'. Do NOT guess from their current job location. " +
          "Do NOT list job skills, generic business terms, or the company's business. Return JSON only.",
        messages: [
          {
            role: "user",
            content:
              `Name: ${c.name}\nBio: ${about || "(none)"}\nSkills: ${skills.join(", ") || "(none)"}\n` +
              `Recent message snippets:\n${convo || "(none)"}\n\n` +
              `Return {"interests": string[] (max 6, lowercase, concise), "hometown": string|null}.`,
          },
        ],
        maxTokens: 200,
        temperature: 0,
      });
      const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      if (Array.isArray(obj.interests)) interests = uniq(obj.interests.map((x: unknown) => String(x))).slice(0, 6);
      if (typeof obj.hometown === "string" && obj.hometown.trim()) hometown = obj.hometown.trim();
    } catch (e) {
      console.error("[personal] interest extraction", e);
    }
  }

  return {
    schools,
    currentCity,
    hometown,
    roleStartDate,
    birthday,
    interests,
    teams: [],
    extractedAt: new Date().toISOString(),
  };
}
