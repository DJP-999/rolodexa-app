import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { connectedAccounts } from "@/db/schema";
import { env, isConfigured } from "@/lib/env";
import { listRecentMessages } from "@/lib/integrations/nylas";
import { getEmails, listAccounts, unipileConfigured } from "@/lib/integrations/unipile";
import { logTouch, normEmail, selfEmails } from "@/lib/sync/track";
import { cleanupNoiseProspects } from "@/lib/sync/noise";

// Wide window so a re-run backfills recently-sent mail (the unique index dedupes overlap).
const UNIPILE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const NYLAS_LOOKBACK_MS = 2 * 60 * 60 * 1000;

/** First attendee identifier (email) from a Unipile email attendee field, defensively. */
function attEmail(a: any): { email: string; name: string | null } | null {
  if (!a) return null;
  const email = normEmail(a.identifier ?? a.email ?? a.address);
  if (!email) return null;
  const name = typeof a.display_name === "string" ? a.display_name : typeof a.name === "string" ? a.name : null;
  return { email, name };
}

/** A clean plain-text body for an email — HTML stripped, quoted reply chains removed —
 *  so the voice learner reads what the user actually wrote. */
function emailBody(e: any): string | null {
  const plain = typeof e?.body_plain === "string" ? e.body_plain : null;
  const html = typeof e?.body === "string" ? e.body : null;
  const snip = typeof e?.snippet === "string" ? e.snippet : null;
  let t = plain ?? snip ?? (html ? html.replace(/<[^>]+>/g, " ") : "");
  if (!t) return null;
  t = t
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  // Drop quoted reply chains / forwarded headers so we only learn the user's own words.
  t = t.split(/On .{0,60}wrote:/i)[0];
  t = t.split(/From:\s.+?Sent:/i)[0];
  return t.slice(0, 1200).trim() || null;
}

/** The mailbox's own address from a Unipile account object, so we can tell sent from received. */
function accountEmail(a: any): string | null {
  const cands = [a?.name, a?.connection_params?.mail?.username, a?.connection_params?.mail?.email, a?.email];
  for (const c of cands) if (typeof c === "string" && c.includes("@")) return c.toLowerCase().trim();
  return null;
}

/**
 * Every-30-min poll. Pulls recent mail and appends idempotent touchpoints — BOTH
 * directions — resolving each to a contact, a cold prospect, or neither. Handles the
 * live Unipile email grant (provider "email") and any legacy Nylas grant.
 */
export async function runEmailPoll(): Promise<void> {
  let inserted = 0;

  // --- Unipile email accounts (the live integration) ---
  if (unipileConfigured()) {
    const cutoff = Date.now() - UNIPILE_LOOKBACK_MS;
    // Map each connected mailbox to its own address so we classify direction correctly.
    const acctEmailById = new Map<string, string>();
    for (const a of await listAccounts()) {
      const em = accountEmail(a);
      if (em && a?.id) acctEmailById.set(String(a.id), em);
    }
    const accts = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.provider, "email"));
    for (const g of accts) {
      if (!g.externalId) continue;
      const self = await selfEmails(g.userId);
      const own = acctEmailById.get(g.externalId);
      if (own) self.add(own);
      // Paginate by date so high-volume mailboxes don't truncate recent (incl. sent) mail.
      const emails = await getEmails(g.externalId, env.EMAIL_POLL_CAP, new Date(cutoff).toISOString());
      for (const e of emails) {
        const id = e?.id ?? e?.message_id;
        const dateRaw = e?.date ?? e?.timestamp ?? e?.received_date;
        const when = dateRaw ? new Date(dateRaw) : null;
        if (!id || !when || isNaN(when.getTime()) || when.getTime() < cutoff) continue;

        const from = attEmail(e?.from_attendee ?? e?.from?.[0] ?? e?.from);
        const rawTo: any[] = Array.isArray(e?.to_attendees) ? e.to_attendees : Array.isArray(e?.to) ? e.to : [];
        const tos = rawTo
          .map(attEmail)
          .filter((x): x is { email: string; name: string | null } => !!x);
        if (!from) continue;

        const outbound = self.has(from.email);
        const other = outbound ? tos.find((t) => !self.has(t.email)) ?? tos[0] ?? null : from;
        if (!other) continue;

        await logTouch({
          userId: g.userId,
          channel: "nylas_email",
          direction: outbound ? "outbound" : "inbound",
          eventType: outbound ? "email_out" : "email_in",
          occurredAt: when,
          sourceRef: String(id),
          threadId: e?.thread_id ?? e?.threadId ?? null,
          counterpartyEmail: other.email,
          counterpartyName: other.name,
          subject: typeof e?.subject === "string" ? e.subject : null,
          text: emailBody(e),
        });
        inserted++;
      }
    }
  }

  // --- Legacy Nylas grants (inbound) ---
  if (isConfigured("nylas")) {
    const grants = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.provider, "nylas_email"));
    const since = Math.floor((Date.now() - NYLAS_LOOKBACK_MS) / 1000);
    for (const g of grants) {
      if (!g.externalId) continue;
      const self = await selfEmails(g.userId);
      const msgs = await listRecentMessages(g.externalId, since);
      for (const m of msgs) {
        const from = m.from?.[0]?.email ? { email: normEmail(m.from[0].email), name: m.from[0].name ?? null } : null;
        const tos = (m.to ?? []).map((t) => ({ email: normEmail(t.email), name: t.name ?? null }));
        if (!from) continue;
        const outbound = self.has(from.email);
        const other = outbound ? tos.find((t) => !self.has(t.email)) ?? tos[0] ?? null : from;
        if (!other) continue;
        await logTouch({
          userId: g.userId,
          channel: "nylas_email",
          direction: outbound ? "outbound" : "inbound",
          eventType: outbound ? "email_out" : "email_in",
          occurredAt: new Date(m.date * 1000),
          sourceRef: m.id,
          threadId: m.threadId ?? null,
          counterpartyEmail: other.email,
          counterpartyName: other.name,
          subject: m.subject ?? null,
        });
        inserted++;
      }
    }
  }

  const removed = await cleanupNoiseProspects();
  console.log(`[emailPoll] processed ${inserted} message(s); removed ${removed} noise prospect(s)`);
}
