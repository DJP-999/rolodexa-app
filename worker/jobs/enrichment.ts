import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, connectedAccounts, interactions } from "@/db/schema";
import { env, isConfigured } from "@/lib/env";
import { search } from "@/lib/integrations/exa";
import { getAllRelations, getChats, getChatMessages, getEmails } from "@/lib/integrations/unipile";
import { writeClaim } from "@/lib/provenance/claims";
import { complete } from "@/lib/llm";
import { deriveWritingStyle } from "@/lib/agent/style";
import { runRecompute } from "./recompute";

type Contact = typeof contacts.$inferSelect;

const norm = (s: string) => s.trim().toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);

const TITLES = new Set([
  "dr", "mr", "mrs", "ms", "prof", "jr", "sr", "ii", "iii", "iv", "phd", "cfa", "mba", "esq",
]);

/** Normalize a name to first+last, accent/title/suffix-insensitive, for fuzzy matching. */
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

/** Extract the LinkedIn vanity slug (/in/<slug>) from any URL form. */
function linkedinSlug(url?: string | null): string | null {
  if (!url) return null;
  const m = url.toLowerCase().match(/\/in\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]).replace(/\/+$/, "") : null;
}

/** Only trust "Title at Company" (single ' at ', no other separators) — no false employers. */
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

/** Match contacts to the user's LinkedIn network (slug first, then fuzzy name). Returns member_id → contactId. */
async function matchLinkedIn(
  userId: string,
  list: Contact[],
  liId: string | null,
): Promise<Map<string, string>> {
  const providerToContact = new Map<string, string>();
  if (!liId || !isConfigured("unipile")) return providerToContact;

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
    if (company && isRealChange(c.company, company)) {
      await writeClaim({
        contactId: c.id,
        field: "job_change",
        value: `${c.name} appears to have moved from ${c.company} to ${company}`,
        sourceUrl: r.public_profile_url ?? null,
        eventDate: today(),
        publishedDate: today(),
        confidence: 0.7,
      });
    }
    await db
      .update(contacts)
      .set({
        linkedinUrl: r.public_profile_url ?? c.linkedinUrl ?? null,
        company: company ?? c.company,
        role: title ?? c.role,
        isVerifiedPerson: true,
        otherSignals: r.headline ? [r.headline] : c.otherSignals,
        enrichedAt: new Date(),
      })
      .where(eq(contacts.id, c.id));
  }
  console.log(`[enrichment] LinkedIn matched ${matched}/${list.length} for ${userId}`);
  return providerToContact;
}

/** Sync recent LinkedIn conversations into interactions (idempotent) → real last-contacted + reply signal. */
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

/** Sync recent email into interactions (idempotent), matched to contacts by address. */
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

/** Batched cheap-model categorization into relationship boxes for one user. */
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

/**
 * Validate Exa results: genuinely about THIS contact AND a noteworthy recent
 * event — strict, to avoid namesake hallucinations. Returns dated, sourced items.
 */
async function extractNews(
  c: Contact,
  results: { title?: string; url: string; publishedDate?: string; text?: string; highlights?: string[] }[],
): Promise<{ value: string; url: string; eventDate: string | null; published: string | null }[]> {
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
      "Extract the event date if stated. Be strict: when unsure whether it's the same person, mark about_this_person false. Return JSON only.",
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
    const out: { value: string; url: string; eventDate: string | null; published: string | null }[] = [];
    for (const x of arr) {
      if (x?.about_this_person && x?.noteworthy && typeof x.i === "number" && results[x.i]) {
        const r = results[x.i];
        out.push({
          value: String(x.summary || r.title || r.url),
          url: r.url,
          eventDate: typeof x.event_date === "string" ? x.event_date : null,
          published: r.publishedDate?.slice(0, 10) ?? null,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Enrichment pass. Cheap/bulk first (LinkedIn match + message/email sync + style
 * learning + categorization), then re-grade, then the rationed paid step (Exa news
 * for priority, validated). Runs nightly and on demand; degrades cleanly when unset.
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

  for (const [userId, list] of byUser) {
    const liId = await accountId(userId, "linkedin");
    const providerToContact = await matchLinkedIn(userId, list, liId);
    if (liId) await syncLinkedInMessages(userId, liId, providerToContact);

    const emailId = await accountId(userId, "email");
    if (emailId) await syncEmail(userId, emailId);

    await deriveWritingStyle(userId);
    await categorizeUser(userId);
  }

  // Re-grade with filled data + real interactions, so relevance + last-contacted are meaningful.
  await runRecompute();

  // Phase C: Exa public milestones for the now-ranked priority set (count-bounded).
  if (isConfigured("exa")) {
    const graded = await db.select().from(contacts);
    const priority = graded
      .filter((c) => !c.isOrganization && ((c.relevance ?? 0) >= 55 || c.highValue))
      .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
      .slice(0, 25);
    const startDate = new Date(Date.now() - env.NEWS_FRESHNESS_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    for (const c of priority) {
      const results = await search({
        query: `${c.name} ${c.company ?? ""} funding OR announcement OR appointed OR award`,
        startPublishedDate: startDate,
        numResults: 4,
      });
      const validated = await extractNews(c, results);
      for (const v of validated) {
        await writeClaim({
          contactId: c.id,
          field: "news",
          value: v.value,
          sourceUrl: v.url,
          eventDate: v.eventDate ?? v.published ?? null,
          publishedDate: v.published,
          confidence: 0.7,
        });
      }
    }
  }

  console.log("[enrichment] pass complete");
}
