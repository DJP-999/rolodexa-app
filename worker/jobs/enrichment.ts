import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { contacts, connectedAccounts, interactions, claims, suggestions, userContext } from "@/db/schema";
import { env, isConfigured } from "@/lib/env";
import { search } from "@/lib/integrations/exa";
import {
  getAllRelations,
  getChats,
  getChatMessages,
  getChatAttendees,
  getEmails,
  getProfile,
  getCalendars,
  getCalendarEvents,
} from "@/lib/integrations/unipile";
import { writeClaim } from "@/lib/provenance/claims";
import { mentionsContact } from "@/lib/match/entity";
import { getXUserByUsername, getRecentTweets, normalizeHandle } from "@/lib/integrations/x";
import { complete } from "@/lib/llm";
import { deriveWritingStyle } from "@/lib/agent/style";
import { runRecompute } from "./recompute";
import { runFitGrade } from "./fitGrade";

type Contact = typeof contacts.$inferSelect;

const norm = (s: string) => s.trim().toLowerCase();

const TITLES = new Set([
  "dr", "mr", "mrs", "ms", "prof", "jr", "sr", "ii", "iii", "iv", "phd", "cfa", "mba", "esq",
]);

function nameKey(name: string): string {
  const t = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !TITLES.has(w));
  if (t.length === 0) return "";
  if (t.length === 1) return t[0];
  return `${t[0]} ${t[t.length - 1]}`;
}

function linkedinSlug(url?: string | null): string | null {
  if (!url) return null;
  const m = url.toLowerCase().match(/\/in\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]).replace(/\/+$/, "") : null;
}

function parseHeadline(headline?: string | null): { title: string | null; company: string | null } {
  if (!headline) return { title: null, company: null };
  const h = headline.trim();
  const parts = h.split(/\s+at\s+/i);
  if (parts.length === 2 && !/[|·•/]/.test(h)) {
    return { title: parts[0].trim() || null, company: parts[1].trim() || null };
  }
  return { title: h || null, company: null };
}

function isRealChange(oldC: string | null, newC: string | null): boolean {
  if (!oldC || !newC) return false;
  const a = norm(oldC);
  const b = norm(newC);
  if (!a || !b || a === b) return false;
  if (a.includes(b) || b.includes(a)) return false;
  return true;
}

/** Parse a LinkedIn date ("YYYY", "YYYY-MM", "YYYY-MM-DD") into an ISO date + age in days. */
function parseLiDate(s: unknown): { iso: string; ageDays: number } | null {
  if (typeof s !== "string" || !s.trim()) return null;
  const t = s.trim();
  const full = /^\d{4}$/.test(t) ? `${t}-01-01` : /^\d{4}-\d{2}$/.test(t) ? `${t}-01` : t;
  const d = new Date(full);
  if (isNaN(d.getTime())) return null;
  return { iso: d.toISOString().slice(0, 10), ageDays: (Date.now() - d.getTime()) / 86_400_000 };
}

type Candidate = {
  contactId: string;
  identifier: string;
  profileUrl: string | null;
  oldCompany: string;
  newCompany: string;
  name: string;
};

async function accountId(userId: string, provider: string): Promise<string | null> {
  const a = (
    await db
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, provider)))
      .limit(1)
  )[0];
  return a?.externalId ?? null;
}

/**
 * Match contacts to the user's LinkedIn network. Corrects company/role from the
 * headline and collects job-change CANDIDATES (a headline employer that differs
 * from the stored one) WITHOUT dating them — a headline can't tell us *when* they
 * moved, so dating happens in a separate profile-lookup pass.
 */
async function matchLinkedIn(
  userId: string,
  list: Contact[],
  liId: string | null,
): Promise<{ providerToContact: Map<string, string>; candidates: Candidate[] }> {
  const providerToContact = new Map<string, string>();
  const candidates: Candidate[] = [];
  if (!liId || !isConfigured("unipile")) return { providerToContact, candidates };

  const relations = await getAllRelations(liId);
  const bySlug = new Map<string, any>();
  const byName = new Map<string, any>();
  for (const r of relations) {
    const slug =
      (r.public_identifier ? String(r.public_identifier).toLowerCase() : null) ??
      linkedinSlug(r.public_profile_url);
    if (slug) bySlug.set(slug, r);
    const nk = nameKey(`${r.first_name ?? ""} ${r.last_name ?? ""}`);
    if (nk) byName.set(nk, r);
  }

  let matched = 0;
  for (const c of list) {
    let r: any = null;
    const cslug = linkedinSlug(c.linkedinUrl);
    if (cslug) r = bySlug.get(cslug);
    if (!r) r = byName.get(nameKey(c.name));
    if (!r) continue;
    matched++;
    if (r.member_id) providerToContact.set(String(r.member_id), c.id);

    const { title, company } = parseHeadline(r.headline);
    const update: Partial<Contact> = {
      linkedinUrl: r.public_profile_url ?? c.linkedinUrl ?? null,
      linkedinMemberId: r.member_id ? String(r.member_id) : c.linkedinMemberId ?? null,
      role: title ?? c.role,
      isVerifiedPerson: true,
      otherSignals: r.headline ? [r.headline] : c.otherSignals,
      enrichedAt: new Date(),
    };

    if (company && isRealChange(c.company, company)) {
      // Defer the company update + dating to the profile-lookup pass.
      candidates.push({
        contactId: c.id,
        identifier: String(r.public_identifier ?? r.member_id ?? ""),
        profileUrl: r.public_profile_url ?? null,
        oldCompany: c.company ?? "",
        newCompany: company,
        name: c.name,
      });
    } else if (company && !c.company) {
      update.company = company;
    }

    await db.update(contacts).set(update).where(eq(contacts.id, c.id));
  }
  console.log(`[enrichment] LinkedIn matched ${matched}/${list.length}; ${candidates.length} move candidate(s)`);
  return { providerToContact, candidates };
}

/** Normalize a Unipile profile into the compact shape the profile page renders. */
function normalizeProfile(p: any): Record<string, unknown> {
  const experience = Array.isArray(p?.work_experience)
    ? p.work_experience
        .map((e: any) => ({
          company: typeof e?.company === "string" ? e.company : null,
          position: typeof e?.position === "string" ? e.position : null,
          location: typeof e?.location === "string" ? e.location : null,
          start: typeof e?.start === "string" ? e.start : null,
          end: typeof e?.end === "string" ? e.end : null,
          current: Boolean(e?.current),
        }))
        .slice(0, 10)
    : [];
  const education = Array.isArray(p?.education)
    ? p.education
        .map((e: any) => ({
          school:
            typeof e?.school === "string" ? e.school : typeof e?.name === "string" ? e.name : null,
          degree: typeof e?.degree === "string" ? e.degree : null,
          field:
            typeof e?.field_of_study === "string"
              ? e.field_of_study
              : typeof e?.field === "string"
                ? e.field
                : null,
          start: typeof e?.start === "string" ? e.start : null,
          end: typeof e?.end === "string" ? e.end : null,
        }))
        .slice(0, 6)
    : [];
  const skills = Array.isArray(p?.skills)
    ? p.skills.map((s: any) => (typeof s === "string" ? s : s?.name)).filter(Boolean).slice(0, 18)
    : [];
  const about =
    typeof p?.summary === "string" ? p.summary : typeof p?.about === "string" ? p.about : null;
  return {
    experience,
    education,
    skills,
    about,
    headline: typeof p?.headline === "string" ? p.headline : null,
    location: typeof p?.location === "string" ? p.location : null,
    followerCount: typeof p?.follower_count === "number" ? p.follower_count : null,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Deep profile pass (rate-limited ~150/day). For the priority set (top relevance /
 * high-value) plus job-change candidates, fetch the full LinkedIn profile: store
 * career + education + skills, refresh company/role from the authoritative current
 * position, and date genuine recent moves into a job_change claim.
 */
async function deepProfilePass(
  userId: string,
  liId: string,
  windowDays: number,
  candidates: Candidate[],
): Promise<void> {
  const all = await db.select().from(contacts).where(eq(contacts.userId, userId));
  const candidateMap = new Map(candidates.map((c) => [c.contactId, c]));
  const targets = all
    .filter(
      (c) =>
        !c.isOrganization &&
        c.linkedinUrl &&
        ((c.relevance ?? 0) >= 55 || c.highValue || candidateMap.has(c.id)),
    )
    .sort(
      (a, b) =>
        Number(Boolean(b.highValue)) - Number(Boolean(a.highValue)) ||
        (b.relevance ?? 0) - (a.relevance ?? 0),
    )
    .slice(0, env.ENRICH_DAILY_LINKEDIN_CAP);

  let fetched = 0;
  let flagged = 0;
  for (const c of targets) {
    const slug = linkedinSlug(c.linkedinUrl) ?? "";
    if (!slug) continue;
    const profile = await getProfile(liId, slug, ["experience", "education", "about", "skills"]);
    if (!profile) continue;
    fetched++;
    const normalized = normalizeProfile(profile);
    const exp: any[] = (profile as any)?.work_experience ?? [];
    const current = exp.find((e) => e?.current) ?? exp[0];
    const newCompany = (typeof current?.company === "string" && current.company) || c.company;
    const newRole = (typeof current?.position === "string" && current.position) || c.role;

    const cand = candidateMap.get(c.id);
    if (cand) {
      const dated = parseLiDate(current?.start);
      if (dated && dated.ageDays >= 0 && dated.ageDays <= windowDays && cand.profileUrl) {
        await writeClaim({
          contactId: c.id,
          field: "job_change",
          value: `${c.name} recently moved to ${newCompany}${cand.oldCompany ? ` from ${cand.oldCompany}` : ""}`,
          sourceUrl: cand.profileUrl,
          eventDate: dated.iso,
          publishedDate: dated.iso,
          confidence: 0.85,
        });
        flagged++;
      }
    }
    await db
      .update(contacts)
      .set({ company: newCompany, role: newRole, profileData: normalized })
      .where(eq(contacts.id, c.id));
  }
  console.log(`[enrichment] deep-profiled ${fetched} contact(s); ${flagged} recent move(s) flagged`);
}

async function syncLinkedInMessages(
  userId: string,
  liId: string,
  providerToContact: Map<string, string>,
  contactsList: Contact[],
): Promise<void> {
  const chats = await getChats(liId);
  if (!chats.length) return;
  const nameMap = new Map<string, string>();
  for (const c of contactsList) {
    const nk = nameKey(c.name);
    if (nk) nameMap.set(nk, c.id);
  }

  // Phase 1: resolve each chat to a contact by the attendee's provider-id.
  const resolved = new Map<string, string>(); // chatId -> contactId
  const unresolved: any[] = [];
  for (const chat of chats) {
    if (!chat?.id) continue;
    const pid = chat.attendee_provider_id ? String(chat.attendee_provider_id) : null;
    const cid = pid ? providerToContact.get(pid) : undefined;
    if (cid) resolved.set(String(chat.id), cid);
    else unresolved.push(chat);
  }

  // Phase 2: for the rest, look up attendees (parallel) and match by provider-id or NAME.
  for (let i = 0; i < unresolved.length; i += 10) {
    const slice = unresolved.slice(i, i + 10);
    const lists = await Promise.all(slice.map((c) => getChatAttendees(String(c.id))));
    slice.forEach((chat, j) => {
      for (const a of lists[j] ?? []) {
        if (a?.is_self) continue;
        const apid = a?.provider_id ? String(a.provider_id) : null;
        const byId = apid ? providerToContact.get(apid) : undefined;
        if (byId) {
          resolved.set(String(chat.id), byId);
          break;
        }
        const anm =
          typeof a?.name === "string" ? a.name : typeof a?.display_name === "string" ? a.display_name : null;
        const byName = anm ? nameMap.get(nameKey(anm)) : undefined;
        if (byName) {
          resolved.set(String(chat.id), byName);
          break;
        }
      }
    });
  }

  // Phase 3: fetch messages (parallel) for resolved chats and log them.
  const entries = [...resolved.entries()];
  let n = 0;
  for (let i = 0; i < entries.length; i += 10) {
    const slice = entries.slice(i, i + 10);
    const msgLists = await Promise.all(slice.map(([chatId]) => getChatMessages(chatId)));
    for (let j = 0; j < slice.length; j++) {
      const [chatId, contactId] = slice[j];
      for (const m of (msgLists[j] ?? []).slice(0, 25)) {
        if (!m?.id || !m?.timestamp) continue;
        const when = new Date(m.timestamp);
        if (isNaN(when.getTime())) continue;
        await db
          .insert(interactions)
          .values({
            userId,
            contactId,
            eventType: m.is_sender ? "message_out" : "message_in",
            direction: m.is_sender ? "outbound" : "inbound",
            channel: "linkedin",
            threadId: chatId,
            occurredAt: when,
            sourceRef: String(m.id),
            metadata: { text: typeof m.text === "string" ? m.text.slice(0, 200) : null },
          })
          .onConflictDoNothing();
      }
      n++;
    }
  }
  console.log(
    `[enrichment] LinkedIn: ${chats.length} chats, ${resolved.size} attributed (${unresolved.length} name lookups)`,
  );
}

/** Best-effort plain-text snippet of an email body, stripped of HTML and quoted replies. */
function emailSnippet(e: any): string | null {
  const plain = typeof e?.body_plain === "string" ? e.body_plain : null;
  const html = typeof e?.body === "string" ? e.body : null;
  const snip = typeof e?.snippet === "string" ? e.snippet : null;
  let txt = plain ?? snip ?? (html ? html.replace(/<[^>]+>/g, " ") : "");
  if (!txt) return null;
  txt = txt
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  // Trim quoted reply chains / forwarded headers so we only learn from what the user actually wrote.
  const cut = txt.search(/On .{0,80} wrote:|-----Original Message-----|From:\s/);
  if (cut > 40) txt = txt.slice(0, cut).trim();
  return txt ? txt.slice(0, 280) : null;
}

async function syncEmail(userId: string, emailId: string): Promise<void> {
  const cs = await db
    .select({ id: contacts.id, email: contacts.email })
    .from(contacts)
    .where(eq(contacts.userId, userId));
  const emailToContact = new Map<string, string>();
  for (const c of cs) if (c.email) emailToContact.set(c.email.toLowerCase(), c.id);
  if (emailToContact.size === 0) return;

  const emails = await getEmails(emailId, 200);
  let n = 0;
  for (const e of emails) {
    const fromAddr = norm(String(e?.from_attendee?.identifier ?? e?.from_attendee?.email ?? ""));
    const tos: string[] = Array.isArray(e?.to_attendees)
      ? e.to_attendees.map((a: any) => norm(String(a?.identifier ?? a?.email ?? "")))
      : [];
    let contactId: string | undefined;
    let inbound = true;
    if (fromAddr && emailToContact.has(fromAddr)) {
      contactId = emailToContact.get(fromAddr);
      inbound = true;
    } else {
      for (const t of tos) {
        if (emailToContact.has(t)) {
          contactId = emailToContact.get(t);
          inbound = false;
          break;
        }
      }
    }
    if (!contactId || !e?.id) continue;
    const when = e?.date ? new Date(e.date) : null;
    if (!when || isNaN(when.getTime())) continue;
    await db
      .insert(interactions)
      .values({
        userId,
        contactId,
        eventType: inbound ? "email_in" : "email_out",
        direction: inbound ? "inbound" : "outbound",
        channel: "nylas_email",
        occurredAt: when,
        sourceRef: String(e.id),
        metadata: {
          subject: typeof e.subject === "string" ? e.subject.slice(0, 200) : null,
          // Only the user's own sent prose feeds writing-style learning; skip inbound bodies.
          ...(inbound ? {} : { text: emailSnippet(e) }),
        },
      })
      .onConflictDoNothing();
    n++;
  }
  console.log(`[enrichment] email synced ${n} messages`);
}

/**
 * Calendar sync — pulls meetings from the connected Google/Outlook calendar and writes a
 * "meeting" interaction for every attendee who is one of your contacts, so the Last
 * interaction column reflects calls/meetings, not just email + LinkedIn. Reuses the same
 * Unipile account as email. No-ops cleanly if the grant has no calendar access.
 */
async function syncCalendar(userId: string, accountId: string): Promise<void> {
  const cs = await db
    .select({ id: contacts.id, email: contacts.email })
    .from(contacts)
    .where(eq(contacts.userId, userId));
  const emailToContact = new Map<string, string>();
  for (const c of cs) if (c.email) emailToContact.set(norm(c.email), c.id);
  if (!emailToContact.size) return;

  const cals = await getCalendars(accountId);
  if (!cals.length) {
    console.log("[enrichment] calendar: none accessible (grant may lack calendar scope)");
    return;
  }
  const cutoff = Date.now() - 365 * 86_400_000; // last year of meetings
  let n = 0;
  for (const cal of cals.slice(0, 4)) {
    const calId = (cal as any)?.id ?? (cal as any)?.calendar_id ?? (cal as any)?.email;
    if (!calId) continue;
    const events = await getCalendarEvents(accountId, String(calId));
    for (const ev of events as any[]) {
      const rawStart =
        ev?.start?.date_time ?? ev?.start?.dateTime ?? ev?.start?.date ?? ev?.start_time ?? ev?.start ?? ev?.when?.start_time;
      const when = rawStart ? new Date(typeof rawStart === "number" ? rawStart * 1000 : rawStart) : null;
      if (!when || isNaN(when.getTime()) || when.getTime() < cutoff) continue;
      const attendees: any[] = ev?.attendees ?? ev?.participants ?? [];
      const evId = String(ev?.id ?? `${calId}:${when.getTime()}`);
      const matched = new Set<string>();
      for (const a of attendees) {
        const em = norm(String(a?.email ?? a?.identifier ?? a?.address ?? ""));
        const cid = em ? emailToContact.get(em) : undefined;
        if (cid) matched.add(cid);
      }
      for (const cid of matched) {
        await db
          .insert(interactions)
          .values({
            userId,
            contactId: cid,
            eventType: "meeting",
            direction: null,
            channel: "nylas_calendar",
            occurredAt: when,
            sourceRef: `${evId}:${cid}`,
            metadata: {
              title:
                typeof ev?.title === "string"
                  ? ev.title.slice(0, 200)
                  : typeof ev?.summary === "string"
                    ? ev.summary.slice(0, 200)
                    : null,
            },
          })
          .onConflictDoNothing();
        n++;
      }
    }
  }
  console.log(`[enrichment] calendar synced ${n} meeting interaction(s)`);
}

async function categorizeUser(userId: string): Promise<void> {
  const refreshed = await db.select().from(contacts).where(eq(contacts.userId, userId));
  const need = refreshed.filter(
    (c) => (!c.relationship || c.relationship === "other") && (c.company || c.role),
  );
  const valid = new Set(["family", "friend", "coworker", "investor", "vendor", "other"]);
  for (let i = 0; i < need.length && i < 300; i += 50) {
    const slice = need.slice(i, i + 50).map((c) => ({
      id: c.id,
      name: c.name,
      company: c.company,
      role: c.role,
    }));
    const raw = await complete({
      tier: "cheap",
      system:
        "You categorize professional contacts for a relationship-first dealmaker (pre-IPO secondaries, lower-middle-market buyouts). " +
        "Categories: family, friend, coworker, investor, vendor, other. " +
        "investor = capital allocators: LPs, family offices, VCs, PE, wealth/asset managers, angels. " +
        "vendor = service providers selling to the user. Use 'other' when unsure. Return JSON only.",
      messages: [
        {
          role: "user",
          content:
            `Assign each contact a category. Return a JSON array of {"id","category"} only.\n` +
            JSON.stringify(slice),
        },
      ],
      maxTokens: 1800,
      temperature: 0,
    });
    try {
      const arr = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
      for (const x of arr) {
        if (x?.id && valid.has(x.category)) {
          await db
            .update(contacts)
            .set({ relationship: x.category as Contact["relationship"] })
            .where(eq(contacts.id, x.id));
        }
      }
    } catch {
      /* skip bad batch */
    }
  }
}

/** Validate Exa results: genuinely about THIS contact, noteworthy, AND dated within the window. */
async function extractNews(
  c: Contact,
  results: { title?: string; url: string; publishedDate?: string; text?: string; highlights?: string[] }[],
  windowDays: number,
): Promise<{ value: string; url: string; eventDate: string }[]> {
  if (!results.length) return [];
  // Deterministic guard FIRST: only consider results that actually name this person or
  // their exact firm. A shared token ("Ion Pacific" vs "Ion Video") is not a match.
  const candidates = results.filter((r) =>
    mentionsContact(c, `${r.title ?? ""} ${r.text ?? ""} ${(r.highlights ?? []).join(" ")} ${r.url}`),
  );
  if (!candidates.length) return [];
  const payload = candidates.map((r, i) => ({
    i,
    title: r.title ?? "",
    url: r.url,
    publishedDate: r.publishedDate ?? null,
    snippet: (r.text ?? r.highlights?.[0] ?? "").slice(0, 300),
  }));
  const raw = await complete({
    tier: "cheap",
    system:
      "You validate web search results about a specific professional contact (and their firm) for a relationship CRM. " +
      "For each result decide TWO things: (1) is it genuinely about THIS exact person OR their EXACT firm — NOT a different person or a company that merely shares a word or partial name " +
      "(e.g. an article about 'Ion Video' is NOT about a contact at 'Ion Pacific'; 'Acme Capital' is NOT 'Acme Health'; a shared first word is NOT a match); and " +
      "(2) does it report a NOTEWORTHY, RECENT professional event (funding, new role or promotion, company launch, award, acquisition, board seat, major milestone)? " +
      "The person or firm named in the article must match exactly. Be strict: when unsure it is the same person/firm, mark about_this_person false. " +
      "The summary MUST explicitly name the matched person or firm. Give the event date if stated. Return JSON only.",
    messages: [
      {
        role: "user",
        content:
          `Person: ${c.name}; Company: ${c.company ?? "unknown"}; Role: ${c.role ?? "unknown"}.\n` +
          `Results: ${JSON.stringify(payload)}\n` +
          `Return a JSON array [{"i":number,"about_this_person":boolean,"noteworthy":boolean,"event_date":"YYYY-MM-DD"|null,"summary":"one factual sentence that names the person or firm"}].`,
      },
    ],
    maxTokens: 800,
    temperature: 0,
  });
  try {
    const arr = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
    const out: { value: string; url: string; eventDate: string }[] = [];
    for (const x of arr) {
      if (!(x?.about_this_person && x?.noteworthy && typeof x.i === "number" && candidates[x.i])) continue;
      const r = candidates[x.i];
      const dated = parseLiDate(x.event_date) ?? parseLiDate(r.publishedDate);
      if (!dated || dated.ageDays < 0 || dated.ageDays > windowDays) continue; // recency gate
      out.push({ value: String(x.summary || r.title || r.url), url: r.url, eventDate: dated.iso });
    }
    return out;
  } catch {
    return [];
  }
}

/** Loose name check so we don't attach a stranger's X account to a contact. */
function xNameMatches(contactName: string, xDisplayName: string): boolean {
  const key = nameKey(contactName); // "first last"
  const last = key.split(" ").pop() ?? "";
  if (last.length < 3) return false;
  return norm(xDisplayName).includes(last);
}

/** Find a plausible X handle for a contact from their stored profile, else a bounded Exa search. */
async function discoverXHandle(c: Contact, canSearch: boolean): Promise<string | null> {
  const blob = c.profileData ? JSON.stringify(c.profileData) : "";
  const fromProfile = blob.match(/(?:x\.com|twitter\.com)\/(@?[A-Za-z0-9_]{1,15})/i);
  const h0 = fromProfile ? normalizeHandle(fromProfile[0]) : null;
  if (h0) return h0;
  if (!canSearch || !isConfigured("exa")) return null;
  const results = await search({
    query: `${c.name} ${c.company ?? ""} (x.com OR twitter.com)`,
    numResults: 5,
  });
  for (const r of results) {
    const h = normalizeHandle(r.url);
    if (h) return h;
  }
  return null;
}

/**
 * Who the news sweep covers: EVERY VIP (high-value) contact, regardless of ranking,
 * plus the top-N others by relevance. VIPs are must-watch, so they're never cut by the cap.
 */
function selectPriority(glist: Contact[], limit: number): Contact[] {
  const eligible = glist.filter(
    (c) => !c.isOrganization && ((c.relevance ?? 0) >= 55 || c.highValue),
  );
  const sorted = eligible.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
  const vips = sorted.filter((c) => c.highValue);
  const rest = sorted.filter((c) => !c.highValue).slice(0, limit);
  const seen = new Set<string>();
  return [...vips, ...rest].filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

/** Web (Exa) public-milestone pass: validated, dated, sourced news claims for priority contacts. */
export async function webNewsPass(glist: Contact[], windowDays: number, limit = 25): Promise<void> {
  if (!isConfigured("exa")) return;
  const startDate = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
  const priority = selectPriority(glist, limit);
  for (const c of priority) {
    // Quote the firm so Exa weights the exact phrase, not a shared first word.
    const firmQ = c.company ? `"${c.company}" ` : "";
    const results = await search({
      query: `${firmQ}${c.name} funding OR announcement OR appointed OR award`,
      startPublishedDate: startDate,
      numResults: 4,
    });
    const validated = await extractNews(c, results, windowDays);
    for (const v of validated) {
      await writeClaim({
        contactId: c.id,
        field: "news",
        value: v.value,
        sourceUrl: v.url,
        eventDate: v.eventDate,
        publishedDate: v.eventDate,
        confidence: 0.7,
      });
    }
  }
}

/** Surface the single most noteworthy recent X post for a contact and store it as a dated, sourced claim. */
export async function xNewsPass(glist: Contact[], windowDays: number, limit = 20): Promise<void> {
  if (!isConfigured("x")) return;
  const priority = selectPriority(glist, limit);

  let discoveries = 0; // bound Exa-backed handle discovery per run
  let posts = 0;
  for (const c of priority) {
    // Resolve an X identity, discovering (and caching) a handle at most once in a while.
    let handle = c.xHandle ?? null;
    let xUserId = c.xUserId ?? null;
    if (!handle) {
      const staleCheck =
        !c.xCheckedAt || Date.now() - new Date(c.xCheckedAt).getTime() > 14 * 86_400_000;
      if (!staleCheck) continue;
      const canSearch = discoveries < 8;
      handle = await discoverXHandle(c, canSearch);
      if (canSearch) discoveries++;
      if (!handle) {
        await db.update(contacts).set({ xCheckedAt: new Date() }).where(eq(contacts.id, c.id));
        continue;
      }
    }
    if (!xUserId) {
      const u = await getXUserByUsername(handle);
      if (!u || !xNameMatches(c.name, u.name)) {
        await db.update(contacts).set({ xCheckedAt: new Date() }).where(eq(contacts.id, c.id));
        continue;
      }
      handle = u.username;
      xUserId = u.id;
      await db
        .update(contacts)
        .set({ xHandle: handle, xUserId, xCheckedAt: new Date() })
        .where(eq(contacts.id, c.id));
    }

    const tweets = await getRecentTweets(xUserId, handle, 10);
    const recent = tweets
      .map((t) => ({ t, d: parseLiDate(t.createdAt) }))
      .filter((x) => x.d && x.d.ageDays >= 0 && x.d.ageDays <= windowDays);
    if (!recent.length) continue;

    const payload = recent.map((x, i) => ({ i, text: x.t.text.slice(0, 280), date: x.d!.iso }));
    const raw = await complete({
      tier: "cheap",
      system:
        "You review a professional contact's recent X (Twitter) posts for a relationship CRM. " +
        "Pick the SINGLE most noteworthy professional update worth referencing or congratulating: funding, launch, new role, milestone, major announcement, or a substantive take. " +
        "Ignore casual chatter, replies, memes, and politics. If nothing is noteworthy, return i = null. Return JSON only.",
      messages: [
        {
          role: "user",
          content:
            `Person: ${c.name}; Company: ${c.company ?? "unknown"}.\n` +
            `Posts: ${JSON.stringify(payload)}\n` +
            `Return {"i": number|null, "summary": "one factual sentence"}.`,
        },
      ],
      maxTokens: 200,
      temperature: 0,
    });

    try {
      const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      if (typeof obj.i !== "number" || !recent[obj.i]) continue;
      const picked = recent[obj.i];
      const dupe = await db
        .select({ id: claims.id })
        .from(claims)
        .where(and(eq(claims.contactId, c.id), eq(claims.sourceUrl, picked.t.url)))
        .limit(1);
      if (dupe.length) continue;
      await writeClaim({
        contactId: c.id,
        field: "x_post",
        value: String(obj.summary || picked.t.text.slice(0, 140)),
        sourceUrl: picked.t.url,
        eventDate: picked.d!.iso,
        publishedDate: picked.d!.iso,
        confidence: 0.65,
      });
      posts++;
    } catch {
      /* skip bad batch */
    }
  }
  console.log(`[enrichment] X pass: ${discoveries} discovered, ${posts} post(s) flagged`);
}

/**
 * Enrichment pass. Recency windows: the FIRST run looks back ~a month
 * (NEWS_FRESHNESS_DAYS), ongoing runs only ~a week (ENRICH_NEWS_DAYS_ONGOING).
 * Job changes are only flagged as news when a profile lookup dates the move inside
 * the window — a stale CSV vs. current LinkedIn employer is corrected silently.
 */
export async function runEnrichment(): Promise<void> {
  const all = await db.select().from(contacts);
  if (!all.length) return;

  const byUser = new Map<string, Contact[]>();
  for (const c of all) {
    const l = byUser.get(c.userId) ?? [];
    l.push(c);
    byUser.set(c.userId, l);
  }

  const windowByUser = new Map<string, number>();
  const candidatesByUser = new Map<string, Candidate[]>();
  const liByUser = new Map<string, string | null>();

  for (const [userId, list] of byUser) {
    const ctx = (
      await db.select().from(userContext).where(eq(userContext.userId, userId)).limit(1)
    )[0];
    const isFirstRun = !ctx?.firstEnrichDone;
    const windowDays = isFirstRun ? env.NEWS_FRESHNESS_DAYS : env.ENRICH_NEWS_DAYS_ONGOING;
    windowByUser.set(userId, windowDays);

    // Clean slate: drop prior (mis-dated) job-change claims + their pending suggestions.
    const contactIds = list.map((c) => c.id);
    if (contactIds.length) {
      await db
        .delete(claims)
        .where(and(eq(claims.field, "job_change"), inArray(claims.contactId, contactIds)));
    }
    await db
      .delete(suggestions)
      .where(
        and(
          eq(suggestions.userId, userId),
          eq(suggestions.status, "pending"),
          inArray(suggestions.triggerType, ["job_change", "milestone"]),
        ),
      );

    const liId = await accountId(userId, "linkedin");
    liByUser.set(userId, liId);
    const { providerToContact, candidates } = await matchLinkedIn(userId, list, liId);
    candidatesByUser.set(userId, candidates);

    if (liId) await syncLinkedInMessages(userId, liId, providerToContact, list);

    const emailId = await accountId(userId, "email");
    if (emailId) await syncEmail(userId, emailId);
    if (emailId) await syncCalendar(userId, emailId);

    await deriveWritingStyle(userId);
    await categorizeUser(userId);

    if (isFirstRun) {
      await db
        .insert(userContext)
        .values({ userId, firstEnrichDone: true })
        .onConflictDoUpdate({ target: userContext.userId, set: { firstEnrichDone: true } });
    }
  }

  await runRecompute();

  // Post-grade, priority-first: deep LinkedIn profiles, then Exa public milestones.
  const graded = await db.select().from(contacts);
  const gByUser = new Map<string, Contact[]>();
  for (const c of graded) {
    const l = gByUser.get(c.userId) ?? [];
    l.push(c);
    gByUser.set(c.userId, l);
  }
  for (const [userId, glist] of gByUser) {
    const windowDays = windowByUser.get(userId) ?? env.NEWS_FRESHNESS_DAYS;
    const liId = liByUser.get(userId);
    if (liId && isConfigured("unipile")) {
      await deepProfilePass(userId, liId, windowDays, candidatesByUser.get(userId) ?? []);
    }
    // Public milestones from the web, then what they are posting on X.
    await webNewsPass(glist, windowDays);
    await xNewsPass(glist, windowDays);
  }

  // Re-grade domain fit now that profiles are fresh; this also re-runs relevance.
  await runFitGrade();

  console.log("[enrichment] pass complete");
}
