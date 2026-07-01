import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { claims, contacts, sportsEventsTable, suggestions, userContext } from "@/db/schema";
import { cadenceForRelevance } from "@/lib/scoring/relevance";
import { outreachSuppressed } from "@/lib/outreach/suppress";
import { isNews } from "@/lib/provenance/claims";
import { mentionsContact } from "@/lib/match/entity";
import { complete } from "@/lib/llm";
import { TONE_GUIDE, stripEmDashes } from "@/lib/agent/tone";
import { getWritingStyleFor } from "@/lib/agent/style";
import { matchSportsMoment, activeEvent, type SportsEvent } from "@/lib/personal/sportsEvents";

// Genuine, well-timed REASONS rank highest; the bare "it's been a while" timer is demoted to a
// last resort (0.35) so it only surfaces when nothing better exists — and even then it carries a
// personal hook (school / city / interest) so it never reads as a cold "we should catch up".
const TRIGGER_WEIGHT = {
  re_engage: 0.35,
  job_change: 0.9,
  milestone: 0.8,
  work_anniversary: 0.82,
  birthday: 0.88,
  personal_event: 0.8,
} as const;

/** Days until the next yearly occurrence of an "MM-DD" or ISO date (0 = today). */
function daysUntilAnnual(s?: string | null): number | null {
  const t = (s ?? "").trim();
  const m = t.match(/(\d{1,2})-(\d{1,2})$/) ?? t.match(/^\d{4}-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const mo = Number(m[1]);
  const day = Number(m[2]);
  if (!mo || !day || mo > 12 || day > 31) return null;
  const now = new Date();
  let next = new Date(now.getFullYear(), mo - 1, day);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (next.getTime() < today.getTime()) next = new Date(now.getFullYear() + 1, mo - 1, day);
  return Math.round((next.getTime() - today.getTime()) / 86_400_000);
}

/** Whole years between an ISO date and today (for "N-year anniversary"). */
function yearsSince(iso?: string | null): number {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return 0;
  return Math.floor((Date.now() - d.getTime()) / (365.25 * 86_400_000));
}

type PProfile = {
  schools?: string[];
  currentCity?: string | null;
  hometown?: string | null;
  roleStartDate?: string | null;
  birthday?: string | null;
  interests?: string[];
};

/** Short, factual "what I know about them personally" string the draft MAY weave in (never invent). */
function personalContextOf(c: { personalProfile?: unknown; location?: string | null }): string | null {
  const p = (c.personalProfile ?? null) as PProfile | null;
  if (!p) return null;
  const bits: string[] = [];
  if (p.schools?.length) bits.push(`Studied at ${p.schools.slice(0, 2).join(", ")}`);
  const city = p.hometown || p.currentCity || c.location || null;
  if (city) bits.push(`Based in ${city}`);
  if (p.interests?.length) bits.push(`Into ${p.interests.slice(0, 3).join(", ")}`);
  return bits.length ? bits.join(". ") : null;
}

/**
 * Proactively open never-messaged but high-relevance imports with a first, no-agenda
 * hello. lastContactedAt is populated ONLY from synced two-way comms, so a large share of
 * a real network legitimately has none — those contacts would otherwise never surface.
 * Bounded per run so the queue (and cost) stays sane; the brief still delivers ~3/day.
 */
const COLD_FIRST_TOUCH_FLOOR = 45;
const MAX_COLD_FIRST_TOUCH_PER_RUN = 30;
const MAX_JOB_MOVE_PER_RUN = 25; // bound the goal-aware job-change drafts per run (cost)
// The firm-news engine fans one item out to several contacts, so a big sweep can surface many
// fresh claims at once; cap the news/milestone drafts per run so an LLM-cost burst is impossible.
// Contacts iterate best-relevance-first, so the cap always spends on the most valuable people.
const MAX_NEWS_DRAFT_PER_RUN = 40;

/** Detects placeholder/meta leaks like "[recent news]" or "Note: ... rewrite it". */
function hasLeak(s: string): boolean {
  return /\[[^\]]*\]/.test(s) || /(^|\s)note:/i.test(s) || /\bneeded\b/i.test(s) || /rewrite it/i.test(s);
}

/** Draft a short, friendly outreach note AS the user, in their learned voice. */
export async function draft(opts: {
  name: string;
  trigger: string;
  focus?: string | null;
  style?: string | null;
  fact?: string;
  personalContext?: string | null;
}): Promise<string> {
  const msg = await complete({
    tier: "strong",
    system:
      "You write outreach AS THE USER (first person), to someone they ALREADY KNOW and have met before — never a stranger or a cold lead. " +
      TONE_GUIDE +
      " Use the recipient's real first name. If a concrete detail is given, reference it casually the way an old friend would (never as a compliment on their work or a reason for reaching out); if not, a genuine no-agenda 'it's been too long, let's catch up' hello with no invented specifics. Never invent facts. Output ONLY the message text." +
      (opts.style
        ? `\n\nKeep the short text-message format above, but write in the user's own voice, their word choice, warmth, and characteristic phrasing (ignore any email greetings or sign-offs from this profile):\n${opts.style}`
        : ""),
    messages: [
      {
        role: "user",
        content:
          `Recipient: ${opts.name}\nReason: ${opts.trigger}` +
          (opts.fact ? `\nConcrete detail: ${opts.fact}` : "") +
          (opts.personalContext
            ? `\nKnown personal details about them — you MAY weave ONE in naturally to make it warm and specific (only if it fits; never force it, never invent beyond this): ${opts.personalContext}`
            : "") +
          (opts.focus ? `\nMy current focus (context only, do NOT bring it up or use it as the reason to reach out): ${opts.focus}` : ""),
      },
    ],
    maxTokens: 160,
    temperature: 0.6,
  });

  if (msg && msg.length > 0 && !msg.startsWith("[llm-stub") && !hasLeak(msg)) return stripEmDashes(msg);

  const first = opts.name.split(/\s+/)[0] || "there";
  if (opts.fact) {
    return stripEmDashes(
      `${first}, congrats on the news! Just saw it and had to say something. We gotta catch up soon, want to hear how it's going.`,
    );
  }
  return stripEmDashes(
    `${first}, it's been way too long! No agenda, you just came to mind. Free to catch up soon?`,
  );
}

/** Parse a rough LinkedIn date ("Apr 2026", "2024", "Present") into a Date, else null. */
function parseRoughDate(s?: string | null): Date | null {
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

type Exp = { company?: string | null; position?: string | null; current?: boolean; start?: string | null; end?: string | null };
const normCo = (s?: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Detect a RECENT job move from the deep profile: the current role started recently, and/or a
 * prior role just ended. Returns both the new and the OLD firm so we can write a goal-aware note.
 */
function recentJobMove(
  profileData: unknown,
  withinMonths = 10,
): { newCompany: string | null; newRole: string | null; oldCompany: string | null; oldRole: string | null } | null {
  const exp: Exp[] = Array.isArray((profileData as { experience?: Exp[] })?.experience)
    ? (profileData as { experience?: Exp[] }).experience!
    : [];
  if (!exp.length) return null;
  const cutoff = Date.now() - withinMonths * 30 * 86_400_000;
  const current = exp.filter((e) => e?.current && e.company);
  const newRole =
    [...current].sort((a, b) => (parseRoughDate(b.start)?.getTime() ?? 0) - (parseRoughDate(a.start)?.getTime() ?? 0))[0] ?? null;
  const newStart = newRole ? parseRoughDate(newRole.start) : null;
  const past = exp.filter((e) => !e?.current && e.company && e.end);
  const oldRole =
    [...past].sort((a, b) => (parseRoughDate(b.end)?.getTime() ?? 0) - (parseRoughDate(a.end)?.getTime() ?? 0))[0] ?? null;
  const oldEnd = oldRole ? parseRoughDate(oldRole.end) : null;
  const recentJoin = newStart && newStart.getTime() >= cutoff;
  const recentLeave = oldEnd && oldEnd.getTime() >= cutoff;
  if (!recentJoin && !recentLeave) return null;
  return {
    newCompany: newRole?.company ?? null,
    newRole: newRole?.position ?? null,
    oldCompany: oldRole?.company ?? null,
    oldRole: oldRole?.position ?? null,
  };
}

/**
 * Goal-aware job-change outreach. The model decides whether the NEW firm or the OLD firm (the one
 * they left) matters to the user, then writes the right message — e.g. an intro-ask to a former
 * team when the OLD firm is the target and the new job is irrelevant. Returns {message, why}.
 */
async function draftJobChange(opts: {
  name: string;
  newCompany: string | null;
  newRole: string | null;
  oldCompany: string | null;
  oldRole: string | null;
  focus?: string | null;
  style?: string | null;
}): Promise<{ message: string; why: string } | null> {
  const raw = await complete({
    tier: "strong",
    system:
      "A contact the user ALREADY KNOWS just changed jobs. Decide which firm matters to the USER'S goals, then write the right outreach AS THE USER (first person). " +
      `USER'S GOALS / FOCUS: ${opts.focus ?? "(not set)"}.\n` +
      "Decide whether the NEW firm or the OLD firm (the one they left) is relevant to the user's goals:\n" +
      "- If the OLD firm fits the user's goals and the NEW one does NOT: the message must NOT be about their new job. Warmly reconnect, lightly acknowledge the move, and naturally ask for a warm introduction to their former colleagues at the OLD firm (a target for the user).\n" +
      "- If the NEW firm fits the user's goals: congratulate the move and open a relevant thread about the new role.\n" +
      "- If neither clearly fits: a brief, warm congrats with no agenda.\n" +
      "Never invent facts about the firms. " +
      TONE_GUIDE +
      (opts.style ? `\n\nWrite in the user's own voice: ${opts.style}` : "") +
      '\n\nReturn STRICT JSON: {"message":"<outreach text, ready to send>","why":"<ONE line for the user: that they joined <new firm> and left <old firm>, how it relates to the user\'s goals, and what this message asks for>"}.',
    messages: [
      {
        role: "user",
        content: `Contact: ${opts.name}. Left: ${opts.oldCompany ?? "(unknown)"}${opts.oldRole ? ` (${opts.oldRole})` : ""}. Joined: ${opts.newCompany ?? "(unknown)"}${opts.newRole ? ` as ${opts.newRole}` : ""}.`,
      },
    ],
    maxTokens: 320,
    temperature: 0.5,
  });
  try {
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    const message = stripEmDashes(String(obj.message ?? "").trim());
    const why = String(obj.why ?? "").trim();
    if (message && !message.startsWith("[llm-stub") && !hasLeak(message)) return { message, why };
  } catch {
    /* fall through */
  }
  return null;
}

async function alreadyPending(userId: string, contactId: string, trigger: string): Promise<boolean> {
  const existing = await db
    .select({ id: suggestions.id })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.userId, userId),
        eq(suggestions.contactId, contactId),
        eq(suggestions.triggerType, trigger as typeof suggestions.$inferInsert["triggerType"]),
        eq(suggestions.status, "pending"),
      ),
    )
    .limit(1);
  return existing.length > 0;
}

function priorityOf(score: number): "high" | "medium" | "low" {
  return score > 0.6 ? "high" : score > 0.4 ? "medium" : "low";
}

/**
 * The proactive engine. For each contact it opens, at most:
 *   • a re-engage (rekindle) draft when they've gone past their check-in cadence, and
 *   • a news / job-change draft from a FRESH, DATED, sourced claim.
 * Each is a personal note written in the user's voice, queued for approval.
 */
export async function runSuggestions(): Promise<void> {
  const all = await db.select().from(contacts);
  // Best-first, so the per-run cold-outreach cap queues your highest-relevance contacts.
  all.sort((a, b) => (b.relevance ?? -1) - (a.relevance ?? -1));
  const ctxCache = new Map<string, { focus: string | null; style: string | null }>();
  let created = 0;
  let coldCreated = 0;
  let jobMoveCreated = 0;
  let newsCreated = 0;

  // Live sports calendar (auto-synced from the web by sportsSync) + the curated fallback.
  let liveSports: SportsEvent[] = [];
  try {
    liveSports = (await db.select().from(sportsEventsTable))
      .map(
        (e): SportsEvent => ({
          id: e.id,
          label: e.label,
          blurb: e.blurb,
          league: e.league as SportsEvent["league"],
          season: e.season,
          window: { start: e.windowStart, end: e.windowEnd },
          schools: e.schools ?? [],
          teams: e.teams ?? [],
        }),
      )
      .filter((e) => activeEvent(e));
  } catch (e) {
    console.error("[suggestions] sports calendar load failed", e);
  }

  // Heal: a milestone suggestion must point to a live, sourced claim. Dismiss any whose
  // claims no longer exist (e.g. orphaned by an earlier purge) so we never show a "Why now"
  // with no source; the loop below re-creates a properly-linked one if the news is still fresh.
  const pendingMilestones = await db
    .select({ id: suggestions.id, claimIds: suggestions.claimIds })
    .from(suggestions)
    .where(and(eq(suggestions.status, "pending"), eq(suggestions.triggerType, "milestone")));
  for (const s of pendingMilestones) {
    const ids = s.claimIds ?? [];
    const live = ids.length
      ? (await db.select({ id: claims.id }).from(claims).where(inArray(claims.id, ids))).length
      : 0;
    if (live === 0) {
      await db
        .update(suggestions)
        .set({ status: "dismissed", updatedAt: new Date() })
        .where(eq(suggestions.id, s.id));
    }
  }

  for (const c of all) {
    if (c.isOrganization) continue;
    // Respect the Telegram controls: blocked/snoozed mute everything; dismissed mutes only the
    // non-news check-in (re_engage), so a real news moment can still surface.
    const checkinMuted = outreachSuppressed(c, false).suppressed;
    const newsMuted = outreachSuppressed(c, true).suppressed;
    if (checkinMuted && newsMuted) continue;

    let cx = ctxCache.get(c.userId);
    if (!cx) {
      const row = (
        await db.select().from(userContext).where(eq(userContext.userId, c.userId)).limit(1)
      )[0];
      // Check-in drafts use the voice Dexa learned for casual catch-ups specifically.
      cx = { focus: row?.currentFocus ?? null, style: await getWritingStyleFor(c.userId, "catch_up") };
      ctxCache.set(c.userId, cx);
    }

    const cadence = cadenceForRelevance(c.relevance ?? null);
    const lastDays = c.lastContactedAt
      ? Math.floor((Date.now() - new Date(c.lastContactedAt).getTime()) / 86_400_000)
      : null;
    const pp = (c.personalProfile ?? null) as PProfile | null;
    const personalCtx = personalContextOf(c);

    // --- Personal moments: genuine, well-timed reasons that keep you top of mind without ever
    // asking for anything. These are the heart of the product, so they're event-gated (block /
    // snooze only) and outrank the generic timer. ---

    // Birthday — fire the day of / day before.
    const bdayIn = daysUntilAnnual(pp?.birthday);
    if (
      bdayIn !== null &&
      bdayIn <= 1 &&
      !outreachSuppressed(c, true).suppressed &&
      !(await alreadyPending(c.userId, c.id, "birthday"))
    ) {
      const score = Math.min(1, ((c.relevance ?? 40) / 100) * TRIGGER_WEIGHT.birthday + 0.25);
      const message = await draft({
        name: c.name,
        trigger:
          bdayIn === 0
            ? "It's their BIRTHDAY today. Send a short, warm, genuine happy-birthday text (no agenda, no business)."
            : "Their birthday is tomorrow. Send a short, warm happy-early-birthday text (no agenda).",
        personalContext: personalCtx,
        style: cx.style,
      });
      await db.insert(suggestions).values({
        userId: c.userId,
        contactId: c.id,
        triggerType: "birthday",
        reason: bdayIn === 0 ? `🎂 ${c.name}'s birthday is today.` : `🎂 ${c.name}'s birthday is tomorrow.`,
        draftMessage: message,
        intentLabel: "Wish them happy birthday",
        priority: priorityOf(score),
        score,
        claimIds: [],
      });
      created++;
    }

    // Work anniversary — N years at their current firm (from LinkedIn role start).
    const annivIn = daysUntilAnnual(pp?.roleStartDate);
    const annivYears = yearsSince(pp?.roleStartDate);
    if (
      annivIn !== null &&
      annivIn <= 1 &&
      annivYears >= 1 &&
      c.company &&
      !outreachSuppressed(c, true).suppressed &&
      !(await alreadyPending(c.userId, c.id, "work_anniversary"))
    ) {
      const score = Math.min(1, ((c.relevance ?? 40) / 100) * TRIGGER_WEIGHT.work_anniversary + 0.2);
      const message = await draft({
        name: c.name,
        trigger: `They're hitting their ${annivYears}-year work anniversary at ${c.company}${
          annivIn === 1 ? " tomorrow" : ""
        }. Send a short, warm note acknowledging the milestone (no agenda).`,
        personalContext: personalCtx,
        style: cx.style,
      });
      await db.insert(suggestions).values({
        userId: c.userId,
        contactId: c.id,
        triggerType: "work_anniversary",
        reason: `🎉 ${c.name} is hitting ${annivYears} years at ${c.company}.`,
        draftMessage: message,
        intentLabel: "Acknowledge their work anniversary",
        priority: priorityOf(score),
        score,
        claimIds: [],
      });
      created++;
    }

    // Sports moment — alma mater in the tournament, or their city's team in the playoffs. The
    // angle matters: their HOMETOWN team is true allegiance; their CURRENT-city team is the
    // playful "are you converting?" angle (they may root for somewhere they grew up).
    const sports = pp ? matchSportsMoment(pp, new Date(), liveSports) : null;
    if (
      sports &&
      !outreachSuppressed(c, true).suppressed &&
      !(await alreadyPending(c.userId, c.id, "personal_event"))
    ) {
      const { event, angle, subject, city } = sports;
      const trigger =
        angle === "alma_mater"
          ? `Their alma mater ${subject} is in ${event.blurb} right now. Send a short, playful catch-up text rooting for their team, then a casual "let's catch up soon" — no business ask.`
          : angle === "hometown_team"
            ? `Their hometown team the ${subject} are in ${event.blurb} — they grew up rooting for them. Short, warm, excited catch-up about the run, then "let's catch up soon".`
            : `The ${subject} (${event.blurb}) are the talk of ${city ?? "their city"}, where they live now, but they're originally from elsewhere so may not even be a fan. Write a short, playful catch-up ribbing them about whether they're converting to a ${subject} fan, then suggest a quick call. Match this vibe: "Hey ${c.name.split(/\s+/)[0]}, how have you been, it's been a while. ${city ?? "The city"} must be going crazy with the ${subject} in ${event.blurb}. You converting yet? Let's catch up on a call soon."`;
      const score = Math.min(1, ((c.relevance ?? 40) / 100) * TRIGGER_WEIGHT.personal_event + 0.25);
      const message = await draft({ name: c.name, trigger, personalContext: personalCtx, style: cx.style });
      await db.insert(suggestions).values({
        userId: c.userId,
        contactId: c.id,
        triggerType: "personal_event",
        reason:
          angle === "alma_mater"
            ? `🏀 ${subject} (their alma mater) is in ${event.blurb}.`
            : angle === "hometown_team"
              ? `🏆 The ${subject}, their hometown team, are in ${event.blurb}.`
              : `🎉 The ${subject} are in ${event.blurb} — the buzz in ${city ?? "their city"}.`,
        draftMessage: message,
        intentLabel: "Text them about the game",
        priority: priorityOf(score),
        score,
        claimIds: [],
      });
      created++;
    }

    // --- Rekindle (LAST RESORT): keep a real relationship warm, OR open a high-relevance import
    // we've never messaged. Demoted weight + a personal hook so it never reads as a cold timer. ---
    if (!checkinMuted && !(await alreadyPending(c.userId, c.id, "re_engage"))) {
      const rel = c.relevance ?? 0;
      const warm = lastDays !== null && lastDays > cadence && rel >= 30;
      const cold =
        lastDays === null &&
        rel >= COLD_FIRST_TOUCH_FLOOR &&
        coldCreated < MAX_COLD_FIRST_TOUCH_PER_RUN &&
        Boolean(c.company || c.role);
      if (warm || cold) {
        const score = warm
          ? Math.min(1, (rel / 100) * TRIGGER_WEIGHT.re_engage + 0.1)
          : Math.min(1, (rel / 100) * TRIGGER_WEIGHT.re_engage);
        const message = await draft({
          name: c.name,
          trigger: warm
            ? `You have not connected in ${lastDays} days; reconnect to keep the relationship warm.`
            : `You know them but have no recorded outreach yet; open with a warm, no-agenda hello.`,
          focus: cx.focus,
          style: cx.style,
          personalContext: personalCtx,
        });
        await db.insert(suggestions).values({
          userId: c.userId,
          contactId: c.id,
          triggerType: "re_engage",
          reason: warm
            ? `No touchpoint with ${c.name} in ${lastDays} days.`
            : `${c.name} is a high-relevance contact you haven't reached out to yet.`,
          draftMessage: message,
          intentLabel: warm ? "Reconnect with a check-in" : "Open the relationship",
          priority: priorityOf(score),
          score,
          claimIds: [],
        });
        created++;
        if (cold) coldCreated++;
      }
    }

    // --- News / job-change / their own posts: a fresh, dated, sourced moment (still allowed
    //     after a dismiss). Bounded per run so a big firm-news sweep can't cause a draft burst. ---
    if (newsMuted) continue;
    const cl = await db.select().from(claims).where(eq(claims.contactId, c.id));
    const fresh = cl
      .filter((x) => isNews(x))
      // Web 'news' claims must verifiably reference this contact's firm/name — drops
      // mismatched items (e.g. an "Ion Video" article stored against an "Ion Pacific"
      // contact). job_change (LinkedIn), li_post (their own profile's posts), and
      // x_post (verified handle) are trusted.
      .filter((x) => x.field !== "news" || mentionsContact(c, `${x.value} ${x.sourceUrl ?? ""}`));
    if (fresh.length && newsCreated < MAX_NEWS_DRAFT_PER_RUN) {
      // Their own LinkedIn post outranks third-party firm coverage: it's what THEY chose to
      // say publicly, so reacting to it is the most personal possible opener.
      const chosen =
        fresh.find((x) => x.field === "job_change") ??
        fresh.find((x) => x.field === "li_post") ??
        fresh.find((x) => x.field === "news") ??
        fresh.find((x) => x.field === "x_post");
      if (chosen) {
        const trigger = chosen.field === "job_change" ? "job_change" : "milestone";
        // Defer a job change to the goal-aware block below when the profile shows the move (it has
        // the richer old + new firm and writes the relevance-driven angle).
        const deferToProfile = trigger === "job_change" && !!recentJobMove(c.profileData);
        if (!deferToProfile && !(await alreadyPending(c.userId, c.id, trigger))) {
          const weight = trigger === "job_change" ? TRIGGER_WEIGHT.job_change : TRIGGER_WEIGHT.milestone;
          // Newer updates rank above stale ones in the digest.
          const ageDays = chosen.eventDate
            ? (Date.now() - new Date(chosen.eventDate).getTime()) / 86_400_000
            : 99;
          const recencyBoost = ageDays <= 2 ? 0.1 : ageDays <= 7 ? 0.05 : 0;
          const score = Math.min(1, ((c.relevance ?? 0) / 100) * weight + 0.15 + recencyBoost);
          const message = await draft({
            name: c.name,
            trigger:
              trigger === "job_change"
                ? "They recently changed roles; congratulate them warmly."
                : chosen.field === "li_post"
                  ? "They just posted this on LinkedIn. React to the SUBSTANCE of what they said the way a peer who knows them would: specific and warm, one beat on their point (never a generic compliment on their work), then a natural 'let's catch up soon'."
                  : chosen.field === "x_post"
                    ? "They just posted something notable on X; react to it naturally."
                    : "Something noteworthy just happened for them. If the news is about their ORGANIZATION (funding, a deal or acquisition, a launch, a partnership, an expansion), congratulate the momentum — they work there and feel it — and let it open a catch-up; never pitch anything. If it's a SETBACK (layoffs, closure, losses), check in with genuine support instead — never congratulate.",
            fact: chosen.value,
            focus: cx.focus,
            style: cx.style,
          });
          await db.insert(suggestions).values({
            userId: c.userId,
            contactId: c.id,
            triggerType: trigger,
            reason: `${c.name}: ${chosen.value}`,
            draftMessage: message,
            intentLabel:
              trigger === "job_change"
                ? "Congratulate on the move"
                : chosen.field === "li_post"
                  ? "React to their LinkedIn post"
                  : chosen.field === "x_post"
                    ? "React to their X post"
                    : "Acknowledge firm/personal news",
            priority: priorityOf(score),
            score,
            claimIds: fresh.map((f) => f.id),
          });
          created++;
          newsCreated++;
        }
      }
    }

    // --- Goal-aware JOB CHANGE from the deep profile: name the new + old firm, judge which fits
    //     the user's goals, and write the right message (e.g. an intro-ask to a FORMER team when
    //     the old firm is the target and the new job is irrelevant). ---
    if (!newsMuted && c.profileData && jobMoveCreated < MAX_JOB_MOVE_PER_RUN) {
      const move = recentJobMove(c.profileData);
      if (
        move &&
        (move.oldCompany || move.newCompany) &&
        normCo(move.oldCompany) !== normCo(move.newCompany) &&
        !(await alreadyPending(c.userId, c.id, "job_change"))
      ) {
        const jc = await draftJobChange({
          name: c.name,
          newCompany: move.newCompany,
          newRole: move.newRole,
          oldCompany: move.oldCompany,
          oldRole: move.oldRole,
          focus: cx.focus,
          style: cx.style,
        });
        if (jc) {
          const score = Math.min(1, ((c.relevance ?? 0) / 100) * TRIGGER_WEIGHT.job_change + 0.15);
          await db.insert(suggestions).values({
            userId: c.userId,
            contactId: c.id,
            triggerType: "job_change",
            reason:
              jc.why ||
              `${c.name} joined ${move.newCompany ?? "a new firm"}${move.oldCompany ? `, left ${move.oldCompany}` : ""}.`,
            draftMessage: jc.message,
            intentLabel: "Job change",
            priority: priorityOf(score),
            score,
            claimIds: [],
          });
          created++;
          jobMoveCreated++;
        }
      }
    }
  }
  console.log(
    `[suggestions] created ${created} suggestions (${jobMoveCreated} job moves, ${newsCreated} news/posts)`,
  );
}
