import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { contacts, connectedAccounts, interactions, claims, suggestions, userContext } from "@/db/schema";
import { env, isConfigured } from "@/lib/env";
import { search } from "@/lib/integrations/exa";
import {
  getAllRelations,
  getChats,
  getChatMessages,
  getEmails,
  getProfile,
} from "@/lib/integrations/unipile";
import { writeClaim } from "@/lib/provenance/claims";
import { complete } from "@/lib/llm";
import { deriveWritingStyle } from "@/lib/agent/style";
import { runRecompute } from "./recompute";

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

/**
 * Date job-change candidates via a rate-limited profile lookup. Updates the
 * contact's company to the authoritative current one, and ONLY writes a dated
 * job_change claim when the current position's start date is inside the window.
 */
async function dateJobChanges(
  liId: string,
  candidates: Candidate[],
  windowDays: number,
  byId: Map<string, Contact>,
): Promise<void> {
  candidates.sort(
    (a, b) => (byId.get(b.contactId)?.relevance ?? 0) - (byId.get(a.contactId)?.relevance ?? 0),
  );
  let used = 0;
  let flagged = 0;
  for (const cand of candidates) {
    if (used >= env.ENRICH_DAILY_LINKEDIN_CAP) break;
    if (!cand.identifier) {
      await db.update(contacts).set({ company: cand.newCompany }).where(eq(contacts.id, cand.contactId));
      continue;
    }
    const profile = await getProfile(liId, cand.identifier, ["experience"]);
    used++;
    const exp: any[] = profile?.work_experience ?? [];
    const current = exp.find((e) => e?.current) ?? exp[0];
    const newCompany = (typeof current?.company === "string" && current.company) || cand.newCompany;
    await db.update(contacts).set({ company: newCompany }).where(eq(contacts.id, cand.contactId));

    const dated = parseLiDate(current?.start);
    if (dated && dated.ageDays >= 0 && dated.ageDays <= windowDays && cand.profileUrl) {
      await writeClaim({
        contactId: cand.contactId,
        field: "job_change",
        value: `${cand.name} recently moved to ${newCompany}${cand.oldCompany ? ` from ${cand.oldCompany}` : ""}`,
        sourceUrl: cand.profileUrl,
        eventDate: dated.iso,
        publishedDate: dated.iso,
        confidence: 0.85,
      });
      flagged++;
    }
  }
  console.log(`[enrichment] profile-dated ${used} candidate(s); ${flagged} recent move(s) flagged`);
}

async function syncLinkedInMessages(
  userId: string,
  liId: string,
  providerToContact: Map<string, string>,
): Promise<void> {
  if (providerToContact.size === 0) return;
  const chats = await getChats(liId);
  let n = 0;
  for (const chat of chats.slice(0, 60)) {
    const pid = chat?.attendee_provider_id ? String(chat.attendee_provider_id) : null;
    const contactId = pid ? providerToContact.get(pid) : undefined;
    if (!contactId || !chat?.id) continue;
    const msgs = await getChatMessages(String(chat.id));
    for (const m of msgs.slice(0, 25)) {
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
          occurredAt: when,
          sourceRef: String(m.id),
          metadata: { text: typeof m.text === "string" ? m.text.slice(0, 200) : null },
        })
        .onConflictDoNothing();
    }
    n++;
  }
  console.log(`[enrichment] LinkedIn messages synced across ${n} chats`);
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
        metadata: { subject: typeof e.subject === "string" ? e.subject.slice(0, 200) : null },
      })
      .onConflictDoNothing();
    n++;
  }
  console.log(`[enrichment] email synced ${n} messages`);
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
  const payload = results.map((r, i) => ({
    i,
    title: r.title ?? "",
    url: r.url,
    publishedDate: r.publishedDate ?? null,
    snippet: (r.text ?? r.highlights?.[0] ?? "").slice(0, 300),
  }));
  const raw = await complete({
    tier: "cheap",
    system:
      "You validate web search results about a specific professional contact for a relationship CRM. " +
      "For each result decide: is it genuinely about THIS person (same individual — not a namesake at a different company or field), " +
      "and does it report a NOTEWORTHY, RECENT professional event (funding, new role or promotion, company launch, award, acquisition, board seat, major milestone)? " +
      "Give the event date if stated. Be strict: when unsure it's the same person, mark about_this_person false. Return JSON only.",
    messages: [
      {
        role: "user",
        content:
          `Person: ${c.name}; Company: ${c.company ?? "unknown"}; Role: ${c.role ?? "unknown"}.\n` +
          `Results: ${JSON.stringify(payload)}\n` +
          `Return a JSON array [{"i":number,"about_this_person":boolean,"noteworthy":boolean,"event_date":"YYYY-MM-DD"|null,"summary":"one factual sentence"}].`,
      },
    ],
    maxTokens: 800,
    temperature: 0,
  });
  try {
    const arr = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
    const out: { value: string; url: string; eventDate: string }[] = [];
    for (const x of arr) {
      if (!(x?.about_this_person && x?.noteworthy && typeof x.i === "number" && results[x.i])) continue;
      const r = results[x.i];
      const dated = parseLiDate(x.event_date) ?? parseLiDate(r.publishedDate);
      if (!dated || dated.ageDays < 0 || dated.ageDays > windowDays) continue; // recency gate
      out.push({ value: String(x.summary || r.title || r.url), url: r.url, eventDate: dated.iso });
    }
    return out;
  } catch {
    return [];
  }
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
    const { providerToContact, candidates } = await matchLinkedIn(userId, list, liId);

    if (liId) {
      const byId = new Map(
        (await db.select().from(contacts).where(eq(contacts.userId, userId))).map((c) => [c.id, c]),
      );
      await dateJobChanges(liId, candidates, windowDays, byId);
      await syncLinkedInMessages(userId, liId, providerToContact);
    }

    const emailId = await accountId(userId, "email");
    if (emailId) await syncEmail(userId, emailId);

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

  // Phase C: Exa public milestones for the priority set, dated within the window.
  if (isConfigured("exa")) {
    const graded = await db.select().from(contacts);
    const gByUser = new Map<string, Contact[]>();
    for (const c of graded) {
      const l = gByUser.get(c.userId) ?? [];
      l.push(c);
      gByUser.set(c.userId, l);
    }
    for (const [userId, glist] of gByUser) {
      const windowDays = windowByUser.get(userId) ?? env.NEWS_FRESHNESS_DAYS;
      const startDate = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
      const priority = glist
        .filter((c) => !c.isOrganization && ((c.relevance ?? 0) >= 55 || c.highValue))
        .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
        .slice(0, 25);
      for (const c of priority) {
        const results = await search({
          query: `${c.name} ${c.company ?? ""} funding OR announcement OR appointed OR award`,
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
  }

  console.log("[enrichment] pass complete");
}
