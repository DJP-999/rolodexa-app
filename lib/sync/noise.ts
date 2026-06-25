import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { coldProspects, interactions, userContext } from "@/db/schema";

// Localpart patterns that signal an automated / no-reply / marketing sender.
const LOCAL_RE =
  /(^|[._-])(no-?reply|donotreply|do-?not-?reply|mailer-daemon|mailer|postmaster|bounce|bounces|dmarc|abuse|daemon|notifications?|notify|newsletters?|marketing|mktg|campaigns?|updates?|alerts?|automated|autoreply|noreply|receipts?|invoices?|billing|mailbot|noreply)([._-]|$)/;

// Subdomain labels that almost always mean bulk/transactional mail (e.g. mail.brand.com).
const SUB_LABELS = new Set([
  "mail", "email", "mailer", "notify", "notifications", "news", "newsletter", "marketing", "mktg",
  "e", "em", "send", "sender", "reply", "bounce", "updates", "mailing", "campaigns", "track", "links", "click", "info",
]);

// Known email-service-provider / bulk-sender root domains.
const ESP_DOMAINS = new Set([
  "beehiiv.com", "mailchimp.com", "mcsv.net", "mcdlv.net", "substack.com", "sendgrid.net", "sendgrid.com",
  "mailgun.org", "amazonses.com", "sparkpostmail.com", "customeriomail.com", "intercom-mail.com",
  "hubspot.com", "hubspotemail.net", "sendinblue.com", "postmarkapp.com", "mandrillapp.com",
  "klaviyomail.com", "cmail19.com", "cmail20.com", "rsgsv.net", "mailchimpapp.net",
]);

/** True when an address is an automated/marketing/no-reply sender — not a real conversation. */
export function isNoiseEmail(raw?: string | null): boolean {
  const e = (raw ?? "").toLowerCase().trim();
  if (!e || !e.includes("@")) return false;
  const [local, domain = ""] = e.split("@");
  if (!local || !domain) return false;
  if (LOCAL_RE.test(local) || local.includes("dmarc")) return true;
  const labels = domain.split(".");
  const subs = labels.slice(0, Math.max(0, labels.length - 2));
  for (const s of subs) if (SUB_LABELS.has(s)) return true;
  const root = labels.slice(-2).join(".");
  if (ESP_DOMAINS.has(root) || ESP_DOMAINS.has(domain)) return true;
  return false;
}

// Per-user manual blacklist, cached briefly so polls don't requery every touch.
const cache = new Map<string, { set: Set<string>; ts: number }>();

export async function getBlacklist(userId: string): Promise<Set<string>> {
  const c = cache.get(userId);
  if (c && Date.now() - c.ts < 30_000) return c.set;
  let set = new Set<string>();
  try {
    const row = (
      await db.select({ b: userContext.blacklistedEmails }).from(userContext).where(eq(userContext.userId, userId)).limit(1)
    )[0];
    set = new Set((row?.b ?? []).map((x) => x.toLowerCase().trim()));
  } catch {
    /* ignore */
  }
  cache.set(userId, { set, ts: Date.now() });
  return set;
}

export function clearBlacklistCache(userId: string): void {
  cache.delete(userId);
}

/** Remove cold prospects (and their interactions) that are automated/marketing senders. */
export async function cleanupNoiseProspects(): Promise<number> {
  try {
    const all = await db.select({ id: coldProspects.id, email: coldProspects.email }).from(coldProspects);
    const ids = all.filter((p) => isNoiseEmail(p.email)).map((p) => p.id);
    if (!ids.length) return 0;
    for (let i = 0; i < ids.length; i += 100) {
      const slice = ids.slice(i, i + 100);
      await db.delete(interactions).where(inArray(interactions.coldProspectId, slice));
      await db.delete(coldProspects).where(inArray(coldProspects.id, slice));
    }
    return ids.length;
  } catch (e) {
    console.error("[noise] cleanup", e);
    return 0;
  }
}
