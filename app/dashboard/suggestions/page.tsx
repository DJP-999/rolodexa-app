import { desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { Sparkles, Check, Clock, X, Calendar, ExternalLink, Linkedin, Mail } from "lucide-react";
import { db } from "@/db";
import { suggestions, contacts, claims, interactions, type Claim } from "@/db/schema";
import { approveAction, snoozeAction, dismissAction, generateAction } from "./actions";
import DraftEditor from "./DraftEditor";

export const dynamic = "force-dynamic";

/** Format a date column (string "YYYY-MM-DD") or timestamp into "Jun 12, 2026". */
function fmtDate(d: string | Date | null | undefined): string | null {
  if (!d) return null;
  const dt = typeof d === "string" ? new Date(d.length <= 10 ? `${d}T00:00:00` : d) : d;
  if (isNaN(dt.getTime())) return null;
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Bare domain for a source link, e.g. "techcrunch.com". */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

/** The factual "when" for a claim: when it was reported, else when it happened, else when we found it. */
function claimWhen(c: Claim): string | null {
  if (c.publishedDate) return `Reported ${fmtDate(c.publishedDate)}`;
  if (c.eventDate) return `Dated ${fmtDate(c.eventDate)}`;
  if (c.observedAt) return `Detected ${fmtDate(c.observedAt)}`;
  return null;
}

const TRIGGER: Record<string, { glyph: string; label: string }> = {
  re_engage: { glyph: "⏰", label: "Re-engage" },
  job_change: { glyph: "💼", label: "Job Change" },
  milestone: { glyph: "🏆", label: "Milestone" },
};
const PRIORITY: Record<string, string> = {
  high: "bg-rose-100 text-rose-600",
  medium: "bg-amber-100 text-amber-700",
  low: "bg-black/[0.05] text-muted",
};
const TABS: [string, string][] = [
  ["pending", "Pending"],
  ["approved", "Approved"],
  ["snoozed", "Snoozed"],
  ["dismissed", "Dismissed"],
];

async function getData(status: string) {
  try {
    const cond =
      status === "approved"
        ? inArray(suggestions.status, ["approved", "sent"])
        : eq(suggestions.status, status as "pending" | "snoozed" | "dismissed");
    const sug = await db
      .select()
      .from(suggestions)
      .where(cond)
      .orderBy(status === "pending" ? desc(suggestions.score) : desc(suggestions.updatedAt))
      .limit(50);
    const cs = await db.select().from(contacts);
    const map = new Map(cs.map((c) => [c.id, c]));

    // Pull the sourced claims behind these suggestions so "Why now" can cite them.
    const allClaimIds = [...new Set(sug.flatMap((s) => s.claimIds ?? []))];
    const claimMap = new Map<string, Claim>();
    if (allClaimIds.length) {
      const cl = await db.select().from(claims).where(inArray(claims.id, allClaimIds));
      for (const c of cl) claimMap.set(c.id, c);
    }
    const pickWhyNow = (ids: string[] | null): Claim | undefined => {
      const list = (ids ?? []).map((id) => claimMap.get(id)).filter((c): c is Claim => !!c);
      if (!list.length) return undefined;
      const dated = list
        .filter((c) => c.field === "job_change" || c.field === "news")
        .sort((a, b) => (b.publishedDate ?? b.eventDate ?? "").localeCompare(a.publishedDate ?? a.eventDate ?? ""));
      return dated[0] ?? list[0];
    };

    // Most-recent interaction per contact → drives the resolved channel + "last interaction" context.
    const cids = [...new Set(sug.map((s) => s.contactId).filter((x): x is string => !!x))];
    const lastIx = new Map<string, { channel: string; occurredAt: Date; about: string | null }>();
    if (cids.length) {
      const ix = await db
        .select()
        .from(interactions)
        .where(inArray(interactions.contactId, cids))
        .orderBy(desc(interactions.occurredAt))
        .limit(1000);
      for (const i of ix) {
        if (!i.contactId || lastIx.has(i.contactId)) continue;
        const md = (i.metadata ?? {}) as { subject?: string; text?: string };
        lastIx.set(i.contactId, { channel: i.channel, occurredAt: i.occurredAt, about: md.subject ?? md.text ?? null });
      }
    }
    const channelFor = (c: typeof contacts.$inferSelect | undefined, last?: { channel: string }) => {
      if (last?.channel === "linkedin") return "linkedin";
      if (last?.channel === "nylas_email") return "email";
      if (c?.linkedinMemberId) return "linkedin";
      if (c?.email) return "email";
      return null;
    };

    return sug.map((s) => {
      const contact = s.contactId ? map.get(s.contactId) : undefined;
      const last = s.contactId ? lastIx.get(s.contactId) : undefined;
      return {
        ...s,
        contact,
        whyNow: pickWhyNow(s.claimIds),
        channel: channelFor(contact, last) as "linkedin" | "email" | null,
        lastIx: last ?? null,
      };
    });
  } catch {
    return null;
  }
}

const EMPTY: Record<string, string> = {
  pending: "Nothing pending. The gate stays silent until something clears the bar.",
  approved: "No approved outreach yet — approve a suggestion to send it.",
  snoozed: "Nothing snoozed.",
  dismissed: "Nothing dismissed.",
};

export default async function SuggestionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const sp = await searchParams;
  const status = ["pending", "approved", "snoozed", "dismissed"].includes(sp.status ?? "")
    ? (sp.status as string)
    : "pending";
  const rows = await getData(status);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight">Suggestions</h1>
          <p className="mt-1 text-sm text-muted">
            AI-generated outreach opportunities for your network.
          </p>
        </div>
        <form action={generateAction}>
          <button className="flex items-center gap-2 rounded-lg bg-black px-3.5 py-2 text-sm font-medium text-white hover:bg-black/90">
            <Sparkles className="h-4 w-4" /> Generate
          </button>
        </form>
      </div>

      <div className="mt-5 flex items-center gap-1 text-sm">
        {TABS.map(([key, label]) => (
          <Link
            key={key}
            href={key === "pending" ? "/dashboard/suggestions" : `/dashboard/suggestions?status=${key}`}
            className={
              status === key
                ? "rounded-full bg-black/[0.06] px-3 py-1 font-medium text-ink"
                : "rounded-full px-3 py-1 text-muted hover:text-ink"
            }
          >
            {label}
          </Link>
        ))}
      </div>

      {!rows ? (
        <p className="mt-8 text-sm text-muted">Connect the database to see suggestions.</p>
      ) : rows.length === 0 ? (
        <p className="mt-8 text-sm text-muted">{EMPTY[status]}</p>
      ) : (
        <div className="mt-5 space-y-4">
          {rows.map((s) => {
            const t = TRIGGER[s.triggerType] ?? { glyph: "•", label: s.triggerType };
            return (
              <div key={s.id} className="card">
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-lg">
                    {t.glyph}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-ink">{s.contact?.name ?? "Contact"}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${PRIORITY[s.priority ?? "medium"]}`}
                      >
                        {s.priority}
                      </span>
                      {s.channel === "linkedin" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-700">
                          <Linkedin className="h-3 w-3" /> LinkedIn
                        </span>
                      ) : s.channel === "email" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700">
                          <Mail className="h-3 w-3" /> Email
                        </span>
                      ) : (
                        <span className="rounded-full bg-black/[0.05] px-2 py-0.5 text-[11px] text-muted">No channel</span>
                      )}
                    </div>
                    <div className="text-xs text-muted">
                      {[s.contact?.role, s.contact?.company].filter(Boolean).join(" · ") || "—"}
                    </div>
                    {/* Quick read on whether this outreach is worth it. */}
                    {(() => {
                      const fit = s.contact?.professionalFit;
                      const rel = s.contact?.relevance;
                      const last = s.lastIx;
                      const days = last ? Math.floor((Date.now() - new Date(last.occurredAt).getTime()) / 86_400_000) : null;
                      return (
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                          {fit != null && (
                            <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-700">
                              Fit {Math.round(fit * 100)}
                            </span>
                          )}
                          {rel != null && (
                            <span className="rounded bg-black/[0.05] px-1.5 py-0.5 font-medium text-ink/70">Relevance {rel}</span>
                          )}
                          {last ? (
                            <span>
                              · Last {fmtDate(last.occurredAt)} ({days}d ago)
                              {last.about ? ` — ${last.about.slice(0, 60)}` : ""}
                            </span>
                          ) : (
                            <span>· No prior interaction logged</span>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs text-muted">
                    <span>{t.label}</span>
                    {s.score != null && <span>{Math.round(s.score * 100)}%</span>}
                  </div>
                </div>

                {/* Brief description of the contact / firm so you can judge at a glance. */}
                {(() => {
                  const pb = (s.contact?.pitchbookData ?? null) as Record<string, string> | null;
                  const desc = s.contact?.summary || pb?.["Description"] || s.contact?.industry || null;
                  return desc ? <p className="mt-2 text-xs italic text-muted">{desc.slice(0, 180)}</p> : null;
                })()}

                <p className="mt-3 text-sm text-ink">{s.reason}</p>

                {(() => {
                  // Factual "Why now": the dated, sourced trigger behind this suggestion.
                  const when = s.whyNow ? claimWhen(s.whyNow) : null;
                  const url = s.whyNow?.sourceUrl ?? null;
                  const lastDays =
                    s.triggerType === "re_engage" && s.contact?.lastContactedAt
                      ? Math.floor(
                          (Date.now() - new Date(s.contact.lastContactedAt).getTime()) / 86_400_000,
                        )
                      : null;
                  if (!when && !url && lastDays === null) return null;
                  return (
                    <div className="mt-3 rounded-xl border border-amber-200/70 bg-amber-50/60 p-3">
                      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-700">
                        <Calendar className="h-3.5 w-3.5" /> Why now
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink/80">
                        {when && <span>{when}</span>}
                        {when && url && <span className="text-amber-700/50">·</span>}
                        {url && (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-medium text-amber-700 hover:underline"
                          >
                            {domainOf(url)} <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                        {lastDays !== null && (
                          <span>
                            Last contacted {fmtDate(s.contact?.lastContactedAt) ?? "—"} ({lastDays}d ago)
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {s.draftMessage && (
                  <DraftEditor id={s.id} initial={s.draftMessage} editable={status === "pending"} />
                )}

                {status === "pending" ? (
                  <div className="mt-3 flex items-center gap-2 text-sm">
                    <form action={approveAction}>
                      <input type="hidden" name="id" value={s.id} />
                      <button className="flex items-center gap-1.5 rounded-lg bg-black px-3 py-1.5 font-medium text-white hover:bg-black/90">
                        <Check className="h-4 w-4" /> Approve
                      </button>
                    </form>
                    <form action={snoozeAction}>
                      <input type="hidden" name="id" value={s.id} />
                      <button className="flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 hover:bg-black/[0.03]">
                        <Clock className="h-4 w-4" /> Snooze 7d
                      </button>
                    </form>
                    <form action={dismissAction}>
                      <input type="hidden" name="id" value={s.id} />
                      <button className="flex items-center gap-1.5 px-3 py-1.5 text-muted hover:text-ink">
                        <X className="h-4 w-4" /> Dismiss
                      </button>
                    </form>
                    <span className="ml-auto text-xs text-muted">{s.intentLabel}</span>
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-2 text-xs text-muted">
                    <span className="capitalize">{s.status}</span>
                    <span className="ml-auto">{s.intentLabel}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
