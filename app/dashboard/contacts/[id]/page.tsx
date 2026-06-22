import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Mail, MapPin, ExternalLink, Briefcase, Newspaper, Activity, Users } from "lucide-react";
import { getContactProfile } from "@/lib/contactProfile";
import DeleteContactButton from "../DeleteContactButton";
import VipToggle from "../VipToggle";

export const dynamic = "force-dynamic";

const REL_BADGE: Record<string, string> = {
  investor: "bg-violet-100 text-violet-700",
  friend: "bg-rose-100 text-rose-700",
  coworker: "bg-sky-100 text-sky-700",
  vendor: "bg-amber-100 text-amber-700",
  family: "bg-emerald-100 text-emerald-700",
  other: "bg-black/[0.05] text-muted",
};

function fmtDate(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
function daysSince(d: Date | string | null): string {
  if (!d) return "—";
  return String(Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000));
}
const CHANNEL_LABEL: Record<string, string> = {
  nylas_email: "Email",
  linkedin: "LinkedIn",
  nylas_calendar: "Meeting",
  telegram: "Telegram",
  imessage: "iMessage",
  agent_audit: "Dexa",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 text-sm text-ink">{children}</div>
    </div>
  );
}
function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-ink">{value}</div>
    </div>
  );
}

export default async function ContactProfile({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await getContactProfile(id).catch(() => null);
  if (!p) notFound();
  const { contact: c, interactions: ix, claims: cls, suggestions: sug, stats, bio, related } = p;

  const initials = c.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const news = cls.filter((x) => x.field === "news" || x.field === "job_change");
  const rp = (c.rpFeatures ?? {}) as Record<string, number>;
  const prof = (c.profileData ?? null) as {
    experience?: {
      company?: string | null;
      position?: string | null;
      location?: string | null;
      start?: string | null;
      end?: string | null;
      current?: boolean;
    }[];
    education?: { school?: string | null; degree?: string | null; field?: string | null; start?: string | null; end?: string | null }[];
    skills?: string[];
  } | null;
  const hasEnrichment = Boolean(
    prof && ((prof.experience?.length ?? 0) || (prof.education?.length ?? 0) || (prof.skills?.length ?? 0)),
  );

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center gap-2 text-sm text-muted">
        <Link href="/dashboard/contacts" className="flex items-center gap-1 hover:text-ink">
          <ArrowLeft className="h-4 w-4" /> Contacts
        </Link>
        <span>/</span>
        <span className="text-ink">{c.name}</span>
      </div>

      {/* Header */}
      <div className="mt-5 flex items-start gap-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-black/[0.05] text-xl font-semibold text-muted">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-[26px] font-bold tracking-tight">
            {c.name} {c.highValue ? "🔥" : ""}
          </h1>
          <p className="text-sm text-muted">
            {[c.role, c.company].filter(Boolean).join(" at ") || "—"}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-4 text-sm text-muted">
            {c.email && (
              <span className="flex items-center gap-1.5">
                <Mail className="h-4 w-4" /> {c.email}
              </span>
            )}
            {c.location && (
              <span className="flex items-center gap-1.5">
                <MapPin className="h-4 w-4" /> {c.location}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <VipToggle id={c.id} initial={!!c.highValue} />
          <DeleteContactButton id={c.id} name={c.name} />
        </div>
      </div>

      {/* Stat strip */}
      <div className="mt-5 grid grid-cols-2 gap-4 rounded-2xl border border-hairline bg-white p-4 sm:grid-cols-4">
        <Stat label="Days since contact" value={daysSince(c.lastContactedAt)} />
        <Stat label="Enrichment" value={c.enrichedAt ? "Enriched" : "Pending"} />
        <Stat
          label="Relationship"
          value={
            <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium capitalize ${REL_BADGE[c.relationship ?? "other"]}`}>
              {c.relationship ?? "other"}
            </span>
          }
        />
        <Stat label="Relevance" value={c.relevance != null ? `${c.relevance}/100` : "—"} />
      </div>

      {/* PROFILE card */}
      <div className="mt-5 rounded-2xl border border-hairline bg-white p-5">
        <div className="text-xs font-semibold tracking-wide text-[#c2683a]">PROFILE</div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name">{c.name}</Field>
          <Field label="Email">{c.email ?? "—"}</Field>
          <Field label="Company">{c.company ?? "—"}</Field>
          <Field label="Role">{c.role ?? "—"}</Field>
          <Field label="Location">{c.location ?? "—"}</Field>
          <Field label="LinkedIn">
            {c.linkedinUrl ? (
              <a
                href={c.linkedinUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[#2d6cf6] hover:underline"
              >
                {c.linkedinUrl.replace(/^https?:\/\//, "")} <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              "—"
            )}
          </Field>
        </div>

        {(c.otherSignals ?? []).length > 0 && (
          <div className="mt-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Signals</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(c.otherSignals ?? []).map((s, i) => (
                <span key={i} className="rounded-md bg-[#fbeee6] px-2 py-0.5 text-xs text-[#c2683a]">
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}

        {bio && (
          <div className="mt-5 border-t border-hairline pt-4">
            <div className="text-sm font-medium text-ink">About {c.name.split(/\s+/)[0]}</div>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted">{bio}</p>
          </div>
        )}
      </div>

      {/* Enrichment — career, education, skills from the deep LinkedIn profile */}
      {hasEnrichment && (
        <div className="mt-5 rounded-2xl border border-hairline bg-white p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Briefcase className="h-4 w-4 text-muted" /> Enrichment
          </h2>
          {(prof?.experience?.length ?? 0) > 0 && (
            <div className="mt-4">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
                Career &amp; experience
              </div>
              <ul className="mt-2 space-y-2">
                {prof!.experience!.map((e, i) => (
                  <li key={i} className="text-sm">
                    <div className="font-medium text-ink">
                      {e.position ?? "—"}
                      {e.company ? <span className="text-muted"> · {e.company}</span> : null}
                    </div>
                    <div className="text-xs text-muted">
                      {[e.start, e.end ?? (e.current ? "Present" : null)].filter(Boolean).join(" – ")}
                      {e.location ? ` · ${e.location}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(prof?.education?.length ?? 0) > 0 && (
            <div className="mt-4">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Education</div>
              <ul className="mt-2 space-y-2">
                {prof!.education!.map((e, i) => (
                  <li key={i} className="text-sm">
                    <div className="font-medium text-ink">{e.school ?? "—"}</div>
                    <div className="text-xs text-muted">
                      {[e.degree, e.field].filter(Boolean).join(", ")}
                      {e.start || e.end ? ` · ${[e.start, e.end].filter(Boolean).join(" – ")}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(prof?.skills?.length ?? 0) > 0 && (
            <div className="mt-4">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
                Interests &amp; skills
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {prof!.skills!.map((s, i) => (
                  <span key={i} className="rounded-md bg-black/[0.04] px-2 py-0.5 text-xs text-ink">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Relationships — others in your network at the same firm */}
      {related.length > 0 && (
        <div className="mt-5 rounded-2xl border border-hairline bg-white p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Users className="h-4 w-4 text-muted" /> Relationships
          </h2>
          <p className="mt-1 text-xs text-muted">Others in your network at {c.company}.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {related.map((r) => (
              <Link
                key={r.id}
                href={`/dashboard/contacts/${r.id}`}
                className="rounded-lg border border-hairline px-3 py-1.5 text-sm hover:bg-black/[0.03]"
              >
                {r.name}
                {r.role ? <span className="text-muted"> · {r.role}</span> : null}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Recent activity */}
      <div className="mt-5 rounded-2xl border border-hairline bg-white p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-4 w-4 text-muted" /> Recent activity
        </h2>
        {ix.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            No synced interactions yet. Connect email/LinkedIn and run enrichment to pull history.
          </p>
        ) : (
          <ul className="mt-3 space-y-2.5">
            {ix.slice(0, 12).map((it) => {
              const meta = (it.metadata ?? {}) as { subject?: string; text?: string };
              return (
                <li key={it.id} className="flex items-start gap-3 text-sm">
                  <span className="mt-0.5 w-16 shrink-0 text-xs text-muted">{fmtDate(it.occurredAt)}</span>
                  <span className="w-16 shrink-0 text-xs font-medium text-ink">
                    {CHANNEL_LABEL[it.channel] ?? it.channel}
                  </span>
                  <span className="text-muted">
                    {it.direction === "outbound" ? "You → " : it.direction === "inbound" ? "→ You: " : ""}
                    {meta.subject ?? meta.text ?? it.eventType.replace(/_/g, " ")}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Recent news */}
      {news.length > 0 && (
        <div className="mt-5 rounded-2xl border border-hairline bg-white p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Newspaper className="h-4 w-4 text-muted" /> Recent news
          </h2>
          <ul className="mt-3 space-y-2">
            {news.map((n) => (
              <li key={n.id} className="text-sm">
                <span className="text-ink">{n.value}</span>{" "}
                {n.eventDate && <span className="text-xs text-muted">· {fmtDate(n.eventDate)}</span>}{" "}
                {n.sourceUrl && (
                  <a href={n.sourceUrl} target="_blank" rel="noreferrer" className="text-xs text-[#2d6cf6] hover:underline">
                    source
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Pending suggestions */}
      {sug.length > 0 && (
        <div className="mt-5 rounded-2xl border border-hairline bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Pending suggestions</h2>
          <div className="mt-3 space-y-3">
            {sug.map((s) => {
              const wc = (s.claimIds ?? []).map((id) => cls.find((c) => c.id === id)).find(Boolean);
              const when = wc?.publishedDate
                ? `Reported ${fmtDate(wc.publishedDate)}`
                : wc?.eventDate
                  ? `Dated ${fmtDate(wc.eventDate)}`
                  : null;
              const showWhy = when || wc?.sourceUrl || (s.triggerType === "re_engage" && c.lastContactedAt);
              return (
                <div key={s.id} className="rounded-xl bg-black/[0.02] p-3">
                  <div className="text-sm text-ink">{s.reason}</div>
                  {showWhy && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                      <span className="font-medium uppercase tracking-wide text-amber-700">Why now</span>
                      {when && <span className="text-muted">{when}</span>}
                      {wc?.sourceUrl && (
                        <a
                          href={wc.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[#2d6cf6] hover:underline"
                        >
                          source
                        </a>
                      )}
                      {!wc && s.triggerType === "re_engage" && c.lastContactedAt && (
                        <span className="text-muted">
                          Last contacted {fmtDate(c.lastContactedAt)} ({daysSince(c.lastContactedAt)}d ago)
                        </span>
                      )}
                    </div>
                  )}
                  {s.draftMessage && (
                    <p className="mt-1.5 text-sm italic text-muted">&ldquo;{s.draftMessage}&rdquo;</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Why this grade */}
      <div className="mt-5 rounded-2xl border border-hairline bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Why this grade?</h2>
        {c.gradeRationale && <p className="mt-3 text-sm text-muted">{c.gradeRationale}</p>}
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted">
          <span>Relevance {c.relevance ?? "—"}/100</span>
          <span>
            Email {stats.emailOut} sent / {stats.emailIn} received
          </span>
          <span>
            LinkedIn {stats.msgOut} sent / {stats.msgIn} received
          </span>
          <span>Meetings {stats.meetings}</span>
          {typeof rp.replyRate === "number" && <span>Reply rate {Math.round(rp.replyRate * 100)}%</span>}
          {typeof rp.initiationRatio === "number" && (
            <span>You initiate {Math.round(rp.initiationRatio * 100)}%</span>
          )}
          {c.replyPropensity != null && (
            <span>Reply propensity {Math.round(c.replyPropensity * 100)}%</span>
          )}
          {c.importPriority != null && <span>Import priority {c.importPriority.toFixed(2)}</span>}
          {c.status && <span className="capitalize">Status {c.status.replace(/_/g, " ")}</span>}
          {c.highValue && <span className="text-amber-600">Flagged high-value</span>}
          {c.gradedAt && <span>Graded {fmtDate(c.gradedAt)}</span>}
        </div>
      </div>

      {/* Details */}
      <div className="mt-5 rounded-2xl border border-hairline bg-white p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Briefcase className="h-4 w-4 text-muted" /> Details
        </h2>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="Industry">{c.industry ?? "—"}</Field>
          <Field label="Status">{c.status ?? "—"}</Field>
          <Field label="Added">{fmtDate(c.createdAt)}</Field>
        </div>
      </div>
    </div>
  );
}
