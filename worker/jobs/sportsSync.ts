import { db } from "@/db";
import { sportsEventsTable } from "@/db/schema";
import { isConfigured } from "@/lib/env";
import { search as exaSearch } from "@/lib/integrations/exa";
import { complete } from "@/lib/llm";

/**
 * Self-maintaining sports calendar. The curated SPORTS_EVENTS list shipped permanently empty
 * (participants were meant to be hand-edited "when a playoff is live"), so the sports-moment
 * engine never fired once. This job replaces the hand edit: twice a week it searches the web
 * for the major US sports moments that are live (or imminent), extracts the ACTUAL participants
 * from sourced results, and upserts them into sports_events — which the suggestion engine reads.
 *
 * Safety property preserved: an event only matches a contact when participants are explicitly
 * extracted from a sourced result. Nothing confident → nothing written → no false nudges.
 */

const QUERIES = [
  "NBA Finals teams schedule",
  "Stanley Cup Final teams schedule",
  "World Series teams schedule",
  "NBA playoffs conference finals teams",
  "MLB playoffs World Series matchup",
  "NFL playoffs Super Bowl teams",
  "March Madness Final Four teams",
  "College Football Playoff championship teams",
];

type Extracted = {
  id: string;
  label: string;
  blurb: string;
  league: "NBA" | "NFL" | "MLB" | "NHL" | "NCAAM" | "NCAAF";
  window_start: string;
  window_end: string;
  teams?: string[];
  schools?: string[];
  source_url?: string;
};

const LEAGUES = new Set(["NBA", "NFL", "MLB", "NHL", "NCAAM", "NCAAF"]);

function validDate(s: unknown): s is string {
  return typeof s === "string" && !isNaN(new Date(s).getTime());
}

export async function runSportsSync(): Promise<void> {
  if (!isConfigured("exa")) {
    console.log("[sports-sync] exa not configured — skip");
    return;
  }
  const now = new Date();
  const startDate = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);

  // Gather fresh coverage of the marquee events; dedupe by URL.
  const seen = new Set<string>();
  const results: { title?: string; url: string; publishedDate?: string; text?: string }[] = [];
  for (const q of QUERIES) {
    try {
      const hits = await exaSearch({ query: q, startPublishedDate: startDate, numResults: 4 });
      for (const r of hits) if (r.url && !seen.has(r.url)) (seen.add(r.url), results.push(r));
    } catch (e) {
      console.error("[sports-sync] exa", e);
    }
  }
  if (!results.length) {
    console.log("[sports-sync] no fresh coverage found");
    return;
  }

  const corpus = results
    .slice(0, 24)
    .map((r) => `# ${r.title ?? ""} (${r.url}) [published ${r.publishedDate ?? "?"}]\n${(r.text ?? "").slice(0, 800)}`)
    .join("\n\n")
    .slice(0, 16000);

  const raw = await complete({
    tier: "cheap",
    system:
      "You maintain a calendar of major US sports moments for a relationship agent (it texts contacts about THEIR team's playoff run). " +
      `Today is ${now.toISOString().slice(0, 10)}. From the web results, extract ONLY events that are LIVE now or start within the next 21 days, from: NBA Finals/Conference Finals, Stanley Cup Final, World Series/MLB playoffs, NFL playoffs/Super Bowl, NCAA men's basketball tournament (March Madness), College Football Playoff. ` +
      "STRICT RULES: (1) participants (team or school names) must be EXPLICITLY stated in the results — never from memory; if participants aren't clearly stated, OMIT the event entirely. (2) Use short team names as fans say them ('Knicks', 'Thunder', not 'New York Knicks'). (3) window_start/window_end = the series' actual date range from the results (end = final possible game). (4) id = kebab-case '<event>-<year>'. (5) blurb = how a fan would name it in a text, e.g. 'the NBA Finals'. " +
      'Return STRICT JSON: {"events": [{"id","label","blurb","league":"NBA|NFL|MLB|NHL|NCAAM|NCAAF","window_start":"YYYY-MM-DD","window_end":"YYYY-MM-DD","teams":["..."],"schools":["..."],"source_url":"..."}]} — teams for pro leagues, schools for NCAA. Empty array when nothing qualifies.',
    messages: [{ role: "user", content: `Web results:\n${corpus}` }],
    maxTokens: 900,
    temperature: 0,
  });

  let events: Extracted[] = [];
  try {
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    if (Array.isArray(obj.events)) events = obj.events;
  } catch {
    console.error("[sports-sync] unparseable extraction");
    return;
  }

  let written = 0;
  for (const e of events) {
    const league = String(e?.league ?? "").toUpperCase();
    const teams = Array.isArray(e?.teams) ? e.teams.map(String).filter(Boolean).slice(0, 8) : [];
    const schools = Array.isArray(e?.schools) ? e.schools.map(String).filter(Boolean).slice(0, 8) : [];
    if (
      !e?.id ||
      !e?.label ||
      !LEAGUES.has(league) ||
      !validDate(e.window_start) ||
      !validDate(e.window_end) ||
      (teams.length === 0 && schools.length === 0) // participants are mandatory — the no-false-nudge rule
    )
      continue;
    const season = new Date(e.window_end).getFullYear();
    await db
      .insert(sportsEventsTable)
      .values({
        id: String(e.id).toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        label: String(e.label),
        blurb: String(e.blurb || e.label),
        league,
        season,
        windowStart: e.window_start,
        windowEnd: e.window_end,
        teams,
        schools,
        sourceUrl: typeof e.source_url === "string" ? e.source_url : null,
      })
      .onConflictDoUpdate({
        target: sportsEventsTable.id,
        set: {
          label: String(e.label),
          blurb: String(e.blurb || e.label),
          league,
          season,
          windowStart: e.window_start,
          windowEnd: e.window_end,
          teams,
          schools,
          sourceUrl: typeof e.source_url === "string" ? e.source_url : null,
          updatedAt: new Date(),
        },
      });
    written++;
  }
  console.log(`[sports-sync] ${written} live event(s) in the calendar`);
}
