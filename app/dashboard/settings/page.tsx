import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, suggestions, jobRuns } from "@/db/schema";
import { isConfigured } from "@/lib/env";
import { getPrimaryUser, getUserContextRow, getConnectedAccount } from "@/lib/user";
import { listAccounts } from "@/lib/integrations/unipile";
import {
  saveContextAction,
  useAccount,
  disconnectAccount,
  connectNewAccount,
  connectNylasCalendar,
  disconnectNylasCalendar,
} from "./actions";
import { WeightsEditor } from "./WeightsEditor";
import { JobsGrid, type Job } from "./JobsGrid";
import { SaveButton } from "./SaveButton";
import { TelegramControls } from "./TelegramControls";
import { DangerZone } from "./DangerZone";

export const dynamic = "force-dynamic";

const TIMEZONES: [string, string][] = [
  ["Pacific/Honolulu", "Hawaii (HST)"],
  ["America/Anchorage", "Alaska (AKST)"],
  ["America/Los_Angeles", "Pacific (PST/PDT)"],
  ["America/Denver", "Mountain (MST/MDT)"],
  ["America/Chicago", "Central (CST/CDT)"],
  ["America/New_York", "Eastern (EST/EDT)"],
  ["Europe/London", "London (GMT/BST)"],
  ["Europe/Paris", "Central Europe (CET/CEST)"],
  ["Europe/Athens", "Eastern Europe (EET/EEST)"],
  ["Asia/Dubai", "Dubai (GST)"],
  ["Asia/Kolkata", "India (IST)"],
  ["Asia/Shanghai", "China (CST)"],
  ["Asia/Tokyo", "Japan (JST)"],
  ["Australia/Sydney", "Sydney (AEST/AEDT)"],
  ["Pacific/Auckland", "New Zealand (NZST/NZDT)"],
];

const JOB_META: [string, string, string][] = [
  ["split-contacts", "Split multi-person rows", "1:30 AM"],
  ["pitchbook-sync", "PitchBook match", "1:45 AM"],
  ["apify-enrich", "LinkedIn profiles (Apify)", "1:00 AM"],
  ["apify-resolve", "Find LinkedIn URLs (Apify)", "1:20 AM"],
  ["enrichment", "Enrichment", "2:00 AM"],
  ["personal-profile", "Learn personal details", "3:15 AM"],
  ["fit-grade", "Score domain fit", "3:30 AM"],
  ["recompute", "Re-grade relevance", "4:00 AM"],
  ["normalize", "Group columns", "4:15 AM"],
  ["suggestions", "Suggestions", "6:00 AM"],
  ["news-scan", "News scan", "10a/3p/6p"],
  ["email-poll", "Email Poll", "Every 30m"],
  ["linkedin-poll", "LinkedIn Poll", "Every 30m"],
  ["message-backfill", "Message backfill", "5:00 AM"],
  ["meetings-sync", "Meetings sync", "Every 2h"],
  ["kpi-analyze", "Conversation analysis", "5:30 AM"],
  ["morning-brief", "Morning brief", "7:00 AM"],
  ["midday-brief", "Midday update", "12:30 PM"],
  ["night-brief", "Night brief", "8:00 PM"],
];

const inputCls =
  "mt-1.5 w-full rounded-lg border border-hairline bg-white px-3 py-2 text-sm outline-none focus:border-black/30";

const SIT_LABELS: Record<string, string> = {
  reschedule: "Reschedules",
  deal_share: "Deal sends",
  catch_up: "Catch-ups",
  intro: "Intros",
  follow_up: "Follow-ups",
  scheduling: "Scheduling",
  ask: "Asks",
  thanks: "Thank-yous",
  general: "General",
};

async function getData() {
  try {
    const user = await getPrimaryUser();
    if (!user) return null;
    const [ctx, linkedin, email, telegram, nylasCal, accounts, runs, cs, pend] = await Promise.all([
      getUserContextRow(user.id),
      getConnectedAccount(user.id, "linkedin"),
      getConnectedAccount(user.id, "email"),
      getConnectedAccount(user.id, "telegram"),
      getConnectedAccount(user.id, "nylas_calendar"),
      listAccounts(),
      db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(80),
      db.select({ enrichedAt: contacts.enrichedAt }).from(contacts).where(eq(contacts.userId, user.id)),
      db
        .select({ c: sql<number>`count(*)` })
        .from(suggestions)
        .where(and(eq(suggestions.userId, user.id), eq(suggestions.status, "pending"))),
    ]);
    const last = new Map<string, { at: string | null; status: string | null }>();
    for (const r of runs) {
      if (last.has(r.name)) continue;
      const ts = r.finishedAt ?? r.startedAt;
      last.set(r.name, { at: ts ? new Date(ts).toISOString() : null, status: r.status });
    }
    return {
      ctx,
      linkedin,
      email,
      telegram,
      nylasCal,
      accounts,
      last,
      total: cs.length,
      enriched: cs.filter((x) => x.enrichedAt).length,
      pending: Number(pend[0]?.c ?? 0),
    };
  } catch {
    return null;
  }
}

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      {desc && <p className="mt-1 text-xs text-muted">{desc}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function AccountPicker({
  label,
  provider,
  accounts,
  connectedId,
  emptyHint,
}: {
  label: string;
  provider: string;
  accounts: any[];
  connectedId: string | null;
  emptyHint: string;
}) {
  if (accounts.length === 0) return <p className="text-xs text-muted">{emptyHint}</p>;
  return (
    <div>
      <div className="text-sm font-medium text-ink">{label}</div>
      <ul className="mt-2 space-y-1.5">
        {accounts.map((a: any) => {
          const connected = connectedId === a.id;
          return (
            <li key={a.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">
                {a.name ?? a.id}
                {connected && <span className="text-good"> · connected</span>}
              </span>
              {connected ? (
                <form action={disconnectAccount}>
                  <input type="hidden" name="provider" value={provider} />
                  <button className="shrink-0 rounded-lg border border-hairline px-3 py-1.5 text-rose-500 hover:bg-rose-50">
                    Disconnect
                  </button>
                </form>
              ) : (
                <form action={useAccount}>
                  <input type="hidden" name="provider" value={provider} />
                  <input type="hidden" name="externalId" value={a.id} />
                  <input type="hidden" name="name" value={a.name ?? ""} />
                  <input type="hidden" name="type" value={a.type ?? ""} />
                  <button className="shrink-0 rounded-lg border border-hairline px-3 py-1.5 hover:bg-black/[0.03]">
                    Use this
                  </button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ cal?: string }>;
}) {
  const sp = await searchParams;
  const data = await getData();
  const ctx = data?.ctx ?? null;
  const unipileOn = isConfigured("unipile");
  const nylasOn = isConfigured("nylas");
  const calConnected = data?.nylasCal?.externalId ?? null;
  const MESSAGING = ["LINKEDIN", "WHATSAPP", "INSTAGRAM", "MESSENGER", "TELEGRAM", "TWITTER", "MOBILE"];
  const accounts = data?.accounts ?? [];
  const linkedinAccounts = accounts.filter((a: any) => String(a?.type).toUpperCase() === "LINKEDIN");
  const emailAccounts = accounts.filter((a: any) => !MESSAGING.includes(String(a?.type).toUpperCase()));
  const jobs: Job[] = JOB_META.map(([name, label, schedule]) => ({
    name,
    label,
    schedule,
    lastRun: data?.last.get(name)?.at ?? null,
    status: data?.last.get(name)?.status ?? null,
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-sm text-muted">Configure your profile, scoring weights, and connections.</p>
      </div>

      <Section
        title="Connected accounts"
        desc="Connect LinkedIn and email through Unipile to power enrichment, message sync, and suggestions."
      >
        {!unipileOn ? (
          <p className="text-xs text-amber-600">Set UNIPILE_DSN and UNIPILE_API_KEY in Railway to enable.</p>
        ) : (
          <div className="space-y-5">
            <AccountPicker
              label="LinkedIn"
              provider="linkedin"
              accounts={linkedinAccounts}
              connectedId={data?.linkedin?.externalId ?? null}
              emptyHint="No LinkedIn account in Unipile yet — connect one in your Unipile dashboard."
            />
            <div>
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-ink">Email (Gmail/Outlook)</div>
                <form action={connectNewAccount}>
                  <button className="rounded-lg border border-hairline px-3 py-1.5 text-sm hover:bg-black/[0.03]">
                    Connect a mailbox
                  </button>
                </form>
              </div>
              <div className="mt-2">
                <AccountPicker
                  label=""
                  provider="email"
                  accounts={emailAccounts}
                  connectedId={data?.email?.externalId ?? null}
                  emptyHint="No mailbox connected yet. Click Connect a mailbox to add one."
                />
              </div>
            </div>
          </div>
        )}
      </Section>

      <Section
        title="Calendar (Nylas)"
        desc="Connect your Google or Microsoft calendar through Nylas to power the Calendar tab and meeting KPIs — no Unipile changes needed."
      >
        {sp.cal === "connected" && (
          <p className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            Calendar connected. Your events are syncing now.
          </p>
        )}
        {sp.cal === "error" && (
          <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">
            Couldn&apos;t connect the calendar. Check the Nylas app config and try again.
          </p>
        )}
        {!nylasOn ? (
          <p className="text-xs text-amber-600">
            Set NYLAS_API_KEY and NYLAS_CLIENT_ID in Railway, and register{" "}
            <code>/api/nylas/callback</code> as a redirect URI in your Nylas app (Google connector with
            calendar scope).
          </p>
        ) : calConnected ? (
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>
              Connected
              {data?.nylasCal?.metadata && typeof (data.nylasCal.metadata as any).email === "string" ? (
                <span className="text-muted"> · {(data.nylasCal.metadata as any).email}</span>
              ) : null}
              <span className="text-good"> · syncing</span>
            </span>
            <form action={disconnectNylasCalendar}>
              <button className="shrink-0 rounded-lg border border-hairline px-3 py-1.5 text-rose-500 hover:bg-rose-50">
                Disconnect
              </button>
            </form>
          </div>
        ) : (
          <form action={connectNylasCalendar}>
            <button className="rounded-lg border border-hairline px-3 py-1.5 text-sm font-medium hover:bg-black/[0.03]">
              Connect Google / Outlook calendar
            </button>
          </form>
        )}
      </Section>

      <Section title="Enrichment & activity">
        <div className="grid grid-cols-3 gap-4">
          {[
            ["Contacts", data?.total ?? 0],
            ["Enriched", data?.enriched ?? 0],
            ["Pending suggestions", data?.pending ?? 0],
          ].map(([label, value]) => (
            <div key={label as string}>
              <div className="text-2xl font-bold text-ink">{value as number}</div>
              <div className="text-xs uppercase tracking-wide text-muted">{label as string}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Your context"
        desc="The biggest driver of who Rolodexa surfaces — it re-grades your whole network on save."
      >
        <form action={saveContextAction} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-ink">Your role</span>
            <input name="role" defaultValue={ctx?.role ?? ""} placeholder="Founder & dealmaker — pre-IPO secondaries, LMM buyouts" className={inputCls} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-ink">What are you focused on?</span>
            <textarea name="currentFocus" defaultValue={ctx?.currentFocus ?? ""} rows={2} placeholder="Raising a $25M LMM buyout SPV; sourcing family-office LPs." className={inputCls} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-ink">Active projects / deals</span>
            <textarea name="activeProjects" defaultValue={ctx?.activeProjects ?? ""} rows={3} placeholder={"SpaceX secondary\nVici Peptides raise"} className={inputCls} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-ink">Priority connections</span>
            <textarea name="priorityConnections" defaultValue={ctx?.priorityConnections ?? ""} rows={2} placeholder="Kevin Henderson, Jennifer Prosek" className={inputCls} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-ink">Writing style</span>
            <span className="block text-xs text-muted">
              {ctx?.writingStyleSource === "manual"
                ? "Manual override. Dexa will not change this. Clear the box to let Dexa learn from your messages again."
                : (ctx?.writingStyleSamples ?? 0) > 0
                  ? `Auto-learned from ${ctx?.writingStyleSamples} of your sent messages${
                      ctx?.writingStyleUpdatedAt
                        ? `, updated ${new Date(ctx.writingStyleUpdatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                        : ""
                    }. It keeps sharpening as you send more. Edit to override.`
                  : "Dexa learns this from your sent emails and LinkedIn messages as they sync. Or write your own."}
            </span>
            <textarea name="writingStyle" defaultValue={ctx?.writingStyle ?? ""} rows={3} className={inputCls} />
          </label>
          {ctx?.writingStyleBySituation && Object.keys(ctx.writingStyleBySituation).length > 0 && (
            <div className="rounded-lg border border-hairline bg-black/[0.02] p-3">
              <div className="text-xs font-medium text-ink">Situational voices learned</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {Object.keys(ctx.writingStyleBySituation as Record<string, string>).map((k) => (
                  <span key={k} className="rounded-full border border-hairline bg-white px-2 py-0.5 text-[11px] text-muted">
                    {SIT_LABELS[k] ?? k}
                  </span>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-muted">
                Dexa writes each kind of outreach in the tone you actually use for it — learned from your sent mail.
              </p>
            </div>
          )}
          <label className="block">
            <span className="text-sm font-medium text-ink">Timezone</span>
            <select name="timezone" defaultValue={ctx?.timezone ?? "America/New_York"} className={inputCls}>
              {TIMEZONES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-muted">Morning brief and notifications use this timezone.</span>
          </label>
          <div className="flex items-center justify-end gap-3">
            <span className="text-xs text-muted">Saving re-grades your whole network on your new context.</span>
            <SaveButton>Save context</SaveButton>
          </div>
        </form>
      </Section>

      <Section title="Scoring weights" desc="Control how suggestions are ranked. Weights are normalized automatically.">
        <WeightsEditor initial={(ctx?.weights ?? {}) as Record<string, number>} />
      </Section>

      <Section
        title="Telegram"
        desc="Chat with Dexa and get proactive nudges. Approvals use tappable buttons."
      >
        <div className="space-y-3 text-sm">
          <div>
            {data?.telegram ? (
              <span className="text-good">Connected ✓ — primary channel for proactive nudges.</span>
            ) : (
              <span className="text-muted">Not connected.</span>
            )}
          </div>
          <TelegramControls connected={Boolean(data?.telegram)} />
        </div>
      </Section>

      <Section title="iMessage" desc="Coming soon — Dexa reaches you on Telegram for now.">
        <p className="text-sm text-muted">iMessage delivery is temporarily unavailable.</p>
      </Section>

      <Section
        title="Meetings"
        desc="Dexa can watch your calendar and offer to join external meetings, take notes, and update your CRM."
      >
        <p className="text-sm text-muted">
          Connect a calendar account to enable meeting watch. (Coming after calendar sync.)
        </p>
      </Section>

      <Section title="Background jobs" desc={`${data?.pending ?? 0} pending suggestions.`}>
        <JobsGrid jobs={jobs} />
      </Section>

      <Section title="Integrations">
        <ul className="space-y-2 text-sm">
          {(
            [
              ["Nylas (email + calendar)", isConfigured("nylas")],
              ["Unipile (LinkedIn + email)", isConfigured("unipile")],
              ["Telegram", isConfigured("telegram")],
              ["Exa.ai (enrichment)", isConfigured("exa")],
              ["Anthropic (LLM)", isConfigured("llm")],
              ["OpenRouter (cheap routing)", isConfigured("openrouter")],
            ] as [string, boolean][]
          ).map(([name, on]) => (
            <li key={name} className="flex justify-between">
              {name} <span className={`chip ${on ? "text-good" : "text-muted"}`}>{on ? "connected" : "not set"}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Data">
        <DangerZone />
      </Section>
    </div>
  );
}
