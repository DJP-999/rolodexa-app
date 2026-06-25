import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { connectedAccounts } from "@/db/schema";
import { isConfigured } from "@/lib/env";
import { listRecentMessages } from "@/lib/integrations/nylas";
import { getEmails, unipileConfigured } from "@/lib/integrations/unipile";
import { logTouch, normEmail, selfEmails } from "@/lib/sync/track";
import { cleanupNoiseProspects } from "@/lib/sync/noise";

const LOOKBACK_MS = 2 * 60 * 60 * 1000; // 2h window; the unique index dedupes overlap.

/** First attendee identifier (email) from a Unipile email attendee field, defensively. */
function attEmail(a: any): { email: string; name: string | null } | null {
  if (!a) return null;
  const email = normEmail(a.identifier ?? a.email ?? a.address);
  if (!email) return null;
  const name = typeof a.display_name === "string" ? a.display_name : typeof a.name === "string" ? a.name : null;
  return { email, name };
}

/**
 * Every-30-min poll. Pulls recent mail and appends idempotent touchpoints — BOTH
 * directions — resolving each to a contact, a cold prospect, or neither. Handles the
 * live Unipile email grant (provider "email") and any legacy Nylas grant.
 */
export async function runEmailPoll(): Promise<void> {
  const cutoff = Date.now() - LOOKBACK_MS;
  let inserted = 0;

  // --- Unipile email accounts (the live integration) ---
  if (unipileConfigured()) {
    const accts = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.provider, "email"));
    for (const g of accts) {
      if (!g.externalId) continue;
      const self = await selfEmails(g.userId);
      const emails = await getEmails(g.externalId, 80);
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
    const since = Math.floor(cutoff / 1000);
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
