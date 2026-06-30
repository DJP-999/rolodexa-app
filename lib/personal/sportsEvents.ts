/**
 * CURATED sports-moment engine (no live API — by design, to keep cost at zero).
 *
 * Two ingredients:
 *  1) CITY_TEAMS — which pro teams a metro roots for, so a contact's HOMETOWN (true allegiance)
 *     or CURRENT CITY (the "your town is buzzing" angle) can be turned into a team.
 *  2) SPORTS_EVENTS — a small, hand-maintained list of the moments worth texting about (a school
 *     in the NCAA tournament, a city's team in the Finals). Populate `teams`/`schools` when a
 *     playoff is actually live; an event with neither never fires, so there are no false nudges.
 *
 * matchSportsMoment() turns a contact's personal profile into the single best hook, and tells you
 * WHICH angle it is so the draft can play it right (root for their alma mater, share their
 * hometown team's run, or rib them about their adopted city's team).
 */

export type League = "NFL" | "NBA" | "MLB" | "NHL";
export type Team = { name: string; league: League };

/** Major US metros → their pro teams. Keys are matched as substrings against a contact's city. */
export const CITY_TEAMS: Record<string, Team[]> = {
  "new york": [
    { name: "Knicks", league: "NBA" }, { name: "Nets", league: "NBA" },
    { name: "Giants", league: "NFL" }, { name: "Jets", league: "NFL" },
    { name: "Yankees", league: "MLB" }, { name: "Mets", league: "MLB" },
    { name: "Rangers", league: "NHL" }, { name: "Islanders", league: "NHL" },
  ],
  miami: [
    { name: "Dolphins", league: "NFL" }, { name: "Heat", league: "NBA" },
    { name: "Marlins", league: "MLB" }, { name: "Panthers", league: "NHL" },
  ],
  boston: [
    { name: "Celtics", league: "NBA" }, { name: "Patriots", league: "NFL" },
    { name: "Red Sox", league: "MLB" }, { name: "Bruins", league: "NHL" },
  ],
  "los angeles": [
    { name: "Lakers", league: "NBA" }, { name: "Clippers", league: "NBA" },
    { name: "Rams", league: "NFL" }, { name: "Chargers", league: "NFL" },
    { name: "Dodgers", league: "MLB" }, { name: "Kings", league: "NHL" },
  ],
  chicago: [
    { name: "Bulls", league: "NBA" }, { name: "Bears", league: "NFL" },
    { name: "Cubs", league: "MLB" }, { name: "White Sox", league: "MLB" }, { name: "Blackhawks", league: "NHL" },
  ],
  philadelphia: [
    { name: "76ers", league: "NBA" }, { name: "Eagles", league: "NFL" },
    { name: "Phillies", league: "MLB" }, { name: "Flyers", league: "NHL" },
  ],
  "san francisco": [
    { name: "Warriors", league: "NBA" }, { name: "49ers", league: "NFL" }, { name: "Giants", league: "MLB" },
  ],
  "bay area": [{ name: "Warriors", league: "NBA" }, { name: "49ers", league: "NFL" }, { name: "Giants", league: "MLB" }],
  dallas: [
    { name: "Mavericks", league: "NBA" }, { name: "Cowboys", league: "NFL" },
    { name: "Rangers", league: "MLB" }, { name: "Stars", league: "NHL" },
  ],
  houston: [{ name: "Rockets", league: "NBA" }, { name: "Texans", league: "NFL" }, { name: "Astros", league: "MLB" }],
  "washington": [
    { name: "Wizards", league: "NBA" }, { name: "Commanders", league: "NFL" },
    { name: "Nationals", league: "MLB" }, { name: "Capitals", league: "NHL" },
  ],
  atlanta: [{ name: "Hawks", league: "NBA" }, { name: "Falcons", league: "NFL" }, { name: "Braves", league: "MLB" }],
  denver: [{ name: "Nuggets", league: "NBA" }, { name: "Broncos", league: "NFL" }, { name: "Avalanche", league: "NHL" }],
  phoenix: [{ name: "Suns", league: "NBA" }, { name: "Cardinals", league: "NFL" }, { name: "Diamondbacks", league: "MLB" }],
  detroit: [{ name: "Pistons", league: "NBA" }, { name: "Lions", league: "NFL" }, { name: "Tigers", league: "MLB" }, { name: "Red Wings", league: "NHL" }],
  minneapolis: [{ name: "Timberwolves", league: "NBA" }, { name: "Vikings", league: "NFL" }, { name: "Twins", league: "MLB" }],
  cleveland: [{ name: "Cavaliers", league: "NBA" }, { name: "Browns", league: "NFL" }, { name: "Guardians", league: "MLB" }],
  "san antonio": [{ name: "Spurs", league: "NBA" }],
  sacramento: [{ name: "Kings", league: "NBA" }],
  orlando: [{ name: "Magic", league: "NBA" }],
  "oklahoma city": [{ name: "Thunder", league: "NBA" }],
  memphis: [{ name: "Grizzlies", league: "NBA" }],
  "new orleans": [{ name: "Pelicans", league: "NBA" }, { name: "Saints", league: "NFL" }],
  milwaukee: [{ name: "Bucks", league: "NBA" }, { name: "Brewers", league: "MLB" }],
  indianapolis: [{ name: "Pacers", league: "NBA" }, { name: "Colts", league: "NFL" }],
  portland: [{ name: "Trail Blazers", league: "NBA" }],
  "salt lake": [{ name: "Jazz", league: "NBA" }],
  charlotte: [{ name: "Hornets", league: "NBA" }, { name: "Panthers", league: "NFL" }],
  toronto: [{ name: "Raptors", league: "NBA" }, { name: "Blue Jays", league: "MLB" }, { name: "Maple Leafs", league: "NHL" }],
  seattle: [{ name: "Seahawks", league: "NFL" }, { name: "Mariners", league: "MLB" }, { name: "Kraken", league: "NHL" }],
  "kansas city": [{ name: "Chiefs", league: "NFL" }, { name: "Royals", league: "MLB" }],
  "tampa": [{ name: "Buccaneers", league: "NFL" }, { name: "Rays", league: "MLB" }, { name: "Lightning", league: "NHL" }],
  pittsburgh: [{ name: "Steelers", league: "NFL" }, { name: "Pirates", league: "MLB" }, { name: "Penguins", league: "NHL" }],
  baltimore: [{ name: "Ravens", league: "NFL" }, { name: "Orioles", league: "MLB" }],
  buffalo: [{ name: "Bills", league: "NFL" }, { name: "Sabres", league: "NHL" }],
};

export type SportsEvent = {
  id: string;
  label: string; // "NBA Finals"
  blurb: string; // "the NBA Finals"
  league: League | "NCAAM" | "NCAAF";
  season: number; // ignore stale-year entries
  window: { start: string; end: string }; // ISO dates the moment is topical
  schools?: string[]; // populate for college events (the teams actually in it)
  teams?: string[]; // populate with the pro teams actually playing when live
};

/**
 * The curated calendar. Windows are seeded for the upcoming seasons; `teams`/`schools` are filled
 * in when a playoff is actually live (ask me to populate the current matchups, or edit here).
 * Until participants are filled, an event matches nobody — so this never fires a wrong nudge.
 */
export const SPORTS_EVENTS: SportsEvent[] = [
  // --- Example of a fully-populated, live event (shape reference) ---
  // { id: "nba-finals-2026", label: "NBA Finals", blurb: "the NBA Finals", league: "NBA",
  //   season: 2026, window: { start: "2026-06-01", end: "2026-06-25" }, teams: ["Knicks", "Thunder"] },
  // { id: "ncaam-2027", label: "March Madness", blurb: "the NCAA tournament", league: "NCAAM",
  //   season: 2027, window: { start: "2027-03-17", end: "2027-04-07" }, schools: ["Duke", "Houston"] },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Teams a city roots for, by substring-matching the city string against known metros. */
export function teamsForCity(city?: string | null): Team[] {
  const c = norm(city ?? "");
  if (!c) return [];
  for (const [metro, teams] of Object.entries(CITY_TEAMS)) {
    if (c.includes(metro)) return teams;
  }
  return [];
}

/** Loose school-name match ("Duke" ~ "Duke University"). */
function sameSchool(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// Sports nudges are HIGHLY time-sensitive: only worth sending while the game/series is live, or
// within a short tail after it concludes. `window.end` is the conclusion date (the deciding game);
// we allow at most GRACE_DAYS after that, then it's stale and never fires.
const GRACE_DAYS = 3;

function active(e: SportsEvent, now: Date): boolean {
  const s = new Date(e.window.start).getTime();
  const en = new Date(e.window.end).getTime() + GRACE_DAYS * 86_400_000;
  const t = now.getTime();
  return t >= s && t <= en;
}

export type SportsHook = {
  event: SportsEvent;
  angle: "alma_mater" | "hometown_team" | "current_city_team";
  subject: string; // school or team name
  city?: string;
};

/**
 * The single best sports hook for a contact right now, or null. Preference order matches genuine
 * allegiance: their alma mater > their hometown team > their adopted (current-city) team.
 */
export function matchSportsMoment(
  p: { schools?: string[]; hometown?: string | null; currentCity?: string | null },
  now: Date = new Date(),
): SportsHook | null {
  const events = SPORTS_EVENTS.filter((e) => active(e, now));
  if (!events.length) return null;

  // 1) Alma mater in a college event — the strongest, most personal hook.
  for (const e of events) {
    if (e.schools?.length && p.schools?.length) {
      const hit = e.schools.find((s) => p.schools!.some((ps) => sameSchool(ps, s)));
      if (hit) return { event: e, angle: "alma_mater", subject: hit };
    }
  }
  // 2) Hometown / high-school-city team — their true rooting interest.
  for (const e of events) {
    if (!e.teams?.length || !p.hometown) continue;
    const home = teamsForCity(p.hometown).map((t) => t.name);
    const hit = e.teams.find((t) => home.includes(t));
    if (hit) return { event: e, angle: "hometown_team", subject: hit, city: p.hometown };
  }
  // 3) Current-city team — the playful "your town is buzzing, converting yet?" angle.
  for (const e of events) {
    if (!e.teams?.length || !p.currentCity) continue;
    const cur = teamsForCity(p.currentCity).map((t) => t.name);
    const hit = e.teams.find((t) => cur.includes(t));
    if (hit) return { event: e, angle: "current_city_team", subject: hit, city: p.currentCity };
  }
  return null;
}
