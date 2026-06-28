import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, connectedAccounts, interactions } from "@/db/schema";
import { isConfigured } from "@/lib/env";
import {
  getAllRelations,
  getChats,
  getChatAttendees,
  getChatMessages,
  getEmails,
  getProfile,
} from "@/lib/integrations/unipile";
import {
  apifyConfigured,
  apifyItemName,
  apifyItemUrl,
  fetchLinkedInProfilesRaw,
  normalizeApifyProfile,
  searchLinkedInProfiles,
} from "@/lib/integrations/apify";
import { nameKey } from "@/lib/match/entity";
import { normalizeProfile } from "@/worker/jobs/enrichment";
import { gradeContactFit } from "@/worker/jobs/fitGrade";

type Contact = typeof contacts.$inferSelect;

function linkedinSlug(url?: string | null): string | null {
  if (!url) return null;
  const m = String(url).toLowerCase().match(/\/in\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]).replace(/\/+$/, "") : null;
}

async function accountExternalId(userId: string, provider: string): Promise<string | null> {
  const a = (
    await db
      .select({ externalId: connectedAccounts.externalId })
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, provider)))
      .limit(1)
  )[0];
  return a?.externalId ?? null;
}

/** Pull a LinkedIn member/provider id out of a Unipile profile or relation object (defensive). */
function memberIdFrom(obj: any): string | null {
  for (const k of ["member_id", "provider_id", "internal_id", "entity_urn", "id"]) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim() && !/^urn:/i.test(v)) return v.trim();
    if (typeof v === "number") return String(v);
  }
  // entity_urn like "urn:li:fsd_profile:ACoAAB..." → take the trailing token.
  const urn = obj?.entity_urn;
  if (typeof urn === "string") {
    const m = urn.match(/([A-Za-z0-9_-]{10,})$/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Resolve a contact's LinkedIn identity (member_id + public URL + headline) WITHOUT assuming
 * you're connected to them. Order:
 *   1) Public-profile lookup by slug — Unipile fetches public profiles for NON-connections too,
 *      and returns the member id we need to pull any DM thread.
 *   2) 1st-degree network match — only useful when you ARE connected, but also recovers a URL
 *      we never had.
 * (A URL for a non-connection with no imported URL is discovered earlier by the Apify search in
 * enrichProfile, so by the time we get here the slug is usually known.)
 */
async function resolveLinkedInIdentity(c: Contact, liId: string): Promise<{
  memberId: string | null;
  url: string | null;
  headline: string | null;
}> {
  // 1) Public profile by slug — works whether or not they're a connection.
  const slug = linkedinSlug(c.linkedinUrl);
  if (slug && isConfigured("unipile")) {
    try {
      const p = await getProfile(liId, slug, ["experience"]);
      const mid = p ? memberIdFrom(p) : null;
      if (mid) {
        return {
          memberId: mid,
          url: c.linkedinUrl ?? null,
          headline: typeof p?.headline === "string" ? p.headline : null,
        };
      }
    } catch (e) {
      console.error("[enrich-one] public profile id lookup", e);
    }
  }
  // 2) 1st-degree network (recovers a URL if we still have none).
  try {
    const relations = await getAllRelations(liId);
    const cslug = linkedinSlug(c.linkedinUrl);
    const want = nameKey(c.name);
    let r: any = null;
    if (cslug) {
      r = relations.find((x) => {
        const s =
          (x.public_identifier ? String(x.public_identifier).toLowerCase() : null) ??
          linkedinSlug(x.public_profile_url);
        return s === cslug;
      });
    }
    if (!r && want) {
      r = relations.find((x) => nameKey(`${x.first_name ?? ""} ${x.last_name ?? ""}`) === want);
    }
    if (r) {
      return {
        memberId: r.member_id ? String(r.member_id) : null,
        url: r.public_profile_url ?? null,
        headline: typeof r.headline === "string" ? r.headline : null,
      };
    }
  } catch (e) {
    console.error("[enrich-one] relations id lookup", e);
  }
  return { memberId: null, url: null, headline: null };
}

/** Full LinkedIn page enrichment. Apify is the primary source; Unipile getProfile is the fallback. */
async function enrichProfile(c: Contact, liId: string | null): Promise<Partial<Contact>> {
  const out: Partial<Contact> = {};
  // 1) Apify by URL, or resolve URL + profile by name+company search.
  if (apifyConfigured()) {
    try {
      let item: any = null;
      if (c.linkedinUrl) {
        item = (await fetchLinkedInProfilesRaw([c.linkedinUrl]))[0] ?? null;
      }
      if (!item && c.company) {
        const items = await searchLinkedInProfiles(`${c.name} ${c.company}`, 3);
        const want = nameKey(c.name);
        item = items.find((it) => nameKey(apifyItemName(it)) === want) ?? null;
      }
      if (item) {
        const normalized = normalizeApifyProfile(item);
        const exp = normalized.experience as Array<{ company: string | null; position: string | null; current: boolean }>;
        const cur = exp.find((e) => e.current) ?? exp[0];
        out.profileData = normalized;
        out.company = (normalized.currentCompany as string | null) || cur?.company || c.company;
        out.role = cur?.position || c.role;
        out.isVerifiedPerson = true;
        out.enrichedAt = new Date();
        const url = apifyItemUrl(item);
        if (url && !c.linkedinUrl) out.linkedinUrl = url;
        return out;
      }
    } catch (e) {
      console.error("[enrich-one] apify profile", e);
    }
  }
  // 2) Unipile fallback: fetch the profile by public slug.
  const slug = linkedinSlug(out.linkedinUrl ?? c.linkedinUrl);
  if (slug && liId && isConfigured("unipile")) {
    try {
      const profile = await getProfile(liId, slug, ["experience", "education", "about", "skills"]);
      if (profile) {
        const normalized = normalizeProfile(profile);
        const exp: any[] = (profile as any)?.work_experience ?? [];
        const cur = exp.find((e) => e?.current) ?? exp[0];
        out.profileData = normalized;
        out.company = (typeof cur?.company === "string" && cur.company) || c.company;
        out.role = (typeof cur?.position === "string" && cur.position) || c.role;
        out.isVerifiedPerson = true;
        out.enrichedAt = new Date();
      }
    } catch (e) {
      console.error("[enrich-one] unipile profile", e);
    }
  }
  return out;
}

/** Backfill LinkedIn DM history for ONE contact, matching their chat by member_id (then name). */
async function backfillLinkedInMessages(
  userId: string,
  liId: string,
  contactId: string,
  memberId: string | null,
  name: string,
): Promise<number> {
  try {
    const chats = await getChats(liId);
    if (!chats.length) return 0;
    const want = nameKey(name);
    const matched: string[] = [];

    // Cheap pass: chats whose primary attendee provider-id is this member.
    if (memberId) {
      for (const chat of chats) {
        if (chat?.id && String(chat.attendee_provider_id ?? "") === memberId) matched.push(String(chat.id));
      }
    }
    // If nothing matched by id, do a BOUNDED attendee/name lookup so we still find their thread.
    if (!matched.length) {
      const pool = chats.slice(0, 300);
      for (let i = 0; i < pool.length; i += 10) {
        const slice = pool.slice(i, i + 10);
        const lists = await Promise.all(slice.map((c) => getChatAttendees(String(c.id))));
        slice.forEach((chat, j) => {
          for (const a of lists[j] ?? []) {
            if (a?.is_self) continue;
            const apid = a?.provider_id ? String(a.provider_id) : null;
            const anm = typeof a?.name === "string" ? a.name : typeof a?.display_name === "string" ? a.display_name : null;
            if ((memberId && apid === memberId) || (want && anm && nameKey(anm) === want)) {
              matched.push(String(chat.id));
              break;
            }
          }
        });
        if (matched.length) break; // one thread is enough for a single contact
      }
    }

    let n = 0;
    for (const chatId of matched) {
      const msgs = await getChatMessages(chatId);
      for (const m of (msgs ?? []).slice(0, 100)) {
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
          .onConflictDoUpdate({
            target: [interactions.userId, interactions.channel, interactions.sourceRef],
            set: { contactId },
          });
        n++;
      }
    }
    return n;
  } catch (e) {
    console.error("[enrich-one] linkedin messages", e);
    return 0;
  }
}

const norm = (s: string) => s.trim().toLowerCase();

/** Best-effort plain-text snippet of an email body, stripped of HTML/quoted replies. */
function emailSnippet(e: any): string | null {
  const plain = typeof e?.body_plain === "string" ? e.body_plain : null;
  const html = typeof e?.body === "string" ? e.body : null;
  const snip = typeof e?.snippet === "string" ? e.snippet : null;
  let txt = plain ?? snip ?? (html ? html.replace(/<[^>]+>/g, " ") : "");
  if (!txt) return null;
  txt = txt.replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const cut = txt.search(/On .{0,80} wrote:|-----Original Message-----|From:\s/);
  if (cut > 40) txt = txt.slice(0, cut).trim();
  return txt ? txt.slice(0, 280) : null;
}

/** Backfill email history for ONE contact (matched by their email address). */
async function backfillEmail(userId: string, emailId: string, contactId: string, email: string): Promise<number> {
  try {
    const addr = norm(email);
    if (!addr) return 0;
    const emails = await getEmails(emailId, 200);
    let n = 0;
    for (const e of emails) {
      const fromAddr = norm(String(e?.from_attendee?.identifier ?? e?.from_attendee?.email ?? ""));
      const tos: string[] = Array.isArray(e?.to_attendees)
        ? e.to_attendees.map((a: any) => norm(String(a?.identifier ?? a?.email ?? "")))
        : [];
      const inbound = fromAddr === addr;
      const outbound = tos.includes(addr);
      if (!inbound && !outbound) continue;
      if (!e?.id) continue;
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
            ...(inbound ? {} : { text: emailSnippet(e) }),
          },
        })
        .onConflictDoUpdate({
          target: [interactions.userId, interactions.channel, interactions.sourceRef],
          set: { contactId },
        });
      n++;
    }
    return n;
  } catch (e) {
    console.error("[enrich-one] email", e);
    return 0;
  }
}

/**
 * Full enrichment for a SINGLE newly-promoted contact: resolve their LinkedIn identity/URL,
 * pull the full LinkedIn profile, backfill LinkedIn DM + email history, then grade fit so they
 * rank immediately. Every step is independently fail-safe; a missing integration just no-ops.
 * Safe to fire-and-forget from the promotion action (the worker process keeps running it).
 */
export async function enrichPromotedContact(contactId: string): Promise<void> {
  const c = (await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1))[0];
  if (!c || c.isOrganization) return;
  const userId = c.userId;
  console.log(`[enrich-one] start ${c.name} (${contactId})`);

  const liId = await accountExternalId(userId, "linkedin");
  const emailId = await accountExternalId(userId, "email");

  // 1) Full LinkedIn page enrichment FIRST (Apify primary, Unipile fallback). For a contact you
  //    are NOT connected to and have no imported URL, the Apify name+company search discovers
  //    their public profile + URL here — so identity resolution below has a slug to work with.
  const profileUpdate = await enrichProfile(c, liId);
  if (Object.keys(profileUpdate).length) {
    await db.update(contacts).set(profileUpdate).where(eq(contacts.id, contactId));
  }

  // 2) Resolve LinkedIn identity (member_id + URL). Connection-independent: tries a public
  //    profile lookup by slug (works for non-connections) before the 1st-degree network match.
  const fresh = (await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1))[0] ?? c;
  let memberId = fresh.linkedinMemberId ?? null;
  if (liId && (!memberId || !fresh.linkedinUrl)) {
    const ident = await resolveLinkedInIdentity(fresh, liId);
    memberId = memberId ?? ident.memberId;
    if (ident.memberId || ident.url) {
      await db
        .update(contacts)
        .set({
          ...(ident.memberId && !fresh.linkedinMemberId ? { linkedinMemberId: ident.memberId } : {}),
          ...(ident.url && !fresh.linkedinUrl ? { linkedinUrl: ident.url } : {}),
        })
        .where(eq(contacts.id, contactId));
    }
  }

  // 3) Message + email history.
  let liMsgs = 0;
  let emailMsgs = 0;
  if (liId && isConfigured("unipile")) {
    liMsgs = await backfillLinkedInMessages(userId, liId, contactId, memberId, c.name);
  }
  if (emailId && isConfigured("unipile") && c.email) {
    emailMsgs = await backfillEmail(userId, emailId, contactId, c.email);
  }
  console.log(`[enrich-one] ${c.name}: ${liMsgs} LinkedIn msg(s), ${emailMsgs} email(s)`);

  // 4) Grade fit immediately (also recomputes relevance + lastContactedAt from the new history).
  try {
    await gradeContactFit(contactId);
  } catch (e) {
    console.error("[enrich-one] grade", e);
  }
  console.log(`[enrich-one] done ${c.name}`);
}
