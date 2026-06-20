import { isConfigured } from "@/lib/env";
import { getPrimaryUser, getUserContextRow, getConnectedAccount } from "@/lib/user";
import { listAccounts } from "@/lib/integrations/unipile";
import {
  saveContextAction,
  useAccount,
  disconnectAccount,
  connectNewAccount,
  enrichNowAction,
} from "./actions";

export const dynamic = "force-dynamic";

const WEIGHTS: [string, number, string][] = [
  ["Professional relevance", 30, "Match to your active projects"],
  ["Recency decay", 25, "Time since you last connected"],
  ["Relationship strength", 20, "Interaction frequency × depth"],
  ["Geographic proximity", 15, "Same region"],
  ["Reply propensity", 10, "Learned: do you actually engage them?"],
];

const JOBS: [string, string][] = [
  ["Email Poll", "every 30m"],
  ["Enrichment (signal-gated)", "2:00 AM"],
  ["Recompute (reply-propensity + relevance)", "4:00 AM"],
  ["Suggestions", "6:00 AM"],
  ["Morning brief", "7:00 AM"],
  ["Midday update", "12:30 PM"],
  ["Night brief", "8:00 PM"],
];

function Status({ on }: { on: boolean }) {
  return (
    <span className={`chip ${on ? "text-good" : "text-muted"}`}>{on ? "connected" : "not set"}</span>
  );
}

async function getData() {
  try {
    const user = await getPrimaryUser();
    if (!user) return { ctx: null, linkedin: null, email: null, accounts: [] as any[] };
    const [ctx, linkedin, email, accounts] = await Promise.all([
      getUserContextRow(user.id),
      getConnectedAccount(user.id, "linkedin"),
      getConnectedAccount(user.id, "email"),
      listAccounts(),
    ]);
    return { ctx, linkedin, email, accounts };
  } catch {
    return { ctx: null, linkedin: null, email: null, accounts: [] as any[] };
  }
}

const inputCls =
  "mt-1.5 w-full rounded-lg border border-hairline bg-white px-3 py-2 text-sm outline-none focus:border-black/30";

export default async function SettingsPage() {
  const { ctx, linkedin, email, accounts } = await getData();
  const unipileOn = isConfigured("unipile");
  const MESSAGING = ["LINKEDIN", "WHATSAPP", "INSTAGRAM", "MESSENGER", "TELEGRAM", "TWITTER", "MOBILE"];
  const linkedinAccounts = accounts.filter((a: any) => String(a?.type).toUpperCase() === "LINKEDIN");
  // Any non-messaging account is a mailbox (Google, Outlook, IMAP/Mail, iCloud, Exchange, …).
  const emailAccounts = accounts.filter(
    (a: any) => !MESSAGING.includes(String(a?.type).toUpperCase()),
  );

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-sm text-muted">Your context, enrichment, scoring weights, and jobs.</p>
      </div>

      <section className="card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Your context</h2>
        <p className="mt-1 text-xs text-muted">
          The single biggest driver of who Rolodexa surfaces. Tell it what you&apos;re working on and
          who matters — it re-grades your whole network on save.
        </p>
        <form action={saveContextAction} className="mt-4 space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-ink">Your role</span>
            <input
              name="role"
              defaultValue={ctx?.role ?? ""}
              placeholder="Founder & dealmaker — pre-IPO secondaries, LMM buyouts, select VC"
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-ink">Current focus</span>
            <span className="block text-xs text-muted">
              What are you raising or closing right now? Ranks who to reach out to.
            </span>
            <textarea
              name="currentFocus"
              defaultValue={ctx?.currentFocus ?? ""}
              rows={2}
              placeholder="Raising a $25M LMM buyout SPV; sourcing family-office LPs in healthcare and industrials."
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-ink">Active projects / deals</span>
            <span className="block text-xs text-muted">
              Names, companies, sectors — one per line or comma-separated.
            </span>
            <textarea
              name="activeProjects"
              defaultValue={ctx?.activeProjects ?? ""}
              rows={3}
              placeholder={"SpaceX secondary\nVici Peptides raise\nHealthcare services roll-up"}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-ink">Priority connections</span>
            <span className="block text-xs text-muted">
              People who always matter — scored higher and flagged high-value (🔥).
            </span>
            <textarea
              name="priorityConnections"
              defaultValue={ctx?.priorityConnections ?? ""}
              rows={2}
              placeholder="Kevin Henderson, Jennifer Prosek, Nathan Lehman"
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-ink">Writing style</span>
            <span className="block text-xs text-muted">
              Auto-learned from your sent messages — Dexa drafts proactive notes in this voice. Edit
              to taste; leave blank to re-learn on the next enrichment.
            </span>
            <textarea
              name="writingStyle"
              defaultValue={ctx?.writingStyle ?? ""}
              rows={3}
              placeholder="Learned automatically once your LinkedIn messages have synced."
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-ink">Timezone</span>
            <input
              name="timezone"
              defaultValue={ctx?.timezone ?? "America/New_York"}
              placeholder="America/New_York"
              className={inputCls}
            />
          </label>
          <div className="flex justify-end">
            <button className="rounded-lg bg-black px-4 py-2 text-sm font-medium text-white hover:bg-black/90">
              Save context
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          LinkedIn &amp; enrichment
        </h2>
        <p className="mt-1 text-xs text-muted">
          Match your rolodex to your LinkedIn network, detect job changes, and pull public
          milestones. Profile lookups are rate-limited (~150/day), so enrichment is priority-first.
        </p>

        {/* LinkedIn account picker */}
        <div className="mt-4">
          <div className="text-sm font-medium text-ink">LinkedIn account</div>
          {!unipileOn ? (
            <p className="mt-1 text-xs text-amber-600">
              Set UNIPILE_DSN and UNIPILE_API_KEY in Railway to enable.
            </p>
          ) : linkedinAccounts.length === 0 ? (
            <p className="mt-1 text-xs text-muted">
              No LinkedIn account found in Unipile — connect one in your Unipile dashboard and it will
              appear here.
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {linkedinAccounts.map((a: any) => {
                const connected = linkedin?.externalId === a.id;
                return (
                  <li key={a.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate">
                      {a.name ?? a.id}
                      {connected && <span className="text-good"> · connected</span>}
                    </span>
                    {connected ? (
                      <form action={disconnectAccount}>
                        <input type="hidden" name="provider" value="linkedin" />
                        <button className="shrink-0 rounded-lg border border-hairline px-3 py-1.5 text-rose-500 hover:bg-rose-50">
                          Disconnect
                        </button>
                      </form>
                    ) : (
                      <form action={useAccount}>
                        <input type="hidden" name="provider" value="linkedin" />
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
          )}
        </div>

        {/* Email account picker */}
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-ink">Email account</div>
            {unipileOn && (
              <form action={connectNewAccount}>
                <button className="rounded-lg border border-hairline px-3 py-1.5 text-sm hover:bg-black/[0.03]">
                  Connect a mailbox
                </button>
              </form>
            )}
          </div>
          {!unipileOn ? (
            <p className="mt-1 text-xs text-amber-600">
              Set UNIPILE_DSN and UNIPILE_API_KEY in Railway to enable.
            </p>
          ) : emailAccounts.length === 0 ? (
            <p className="mt-1 text-xs text-muted">
              No mailbox connected in Unipile yet. Click Connect a mailbox to add dp@djpcapital.io via
              Unipile&apos;s secure wizard, then choose it here.
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {emailAccounts.map((a: any) => {
                const connected = email?.externalId === a.id;
                return (
                  <li key={a.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate">
                      {a.name ?? a.id}
                      {connected && <span className="text-good"> · connected</span>}
                    </span>
                    {connected ? (
                      <form action={disconnectAccount}>
                        <input type="hidden" name="provider" value="email" />
                        <button className="shrink-0 rounded-lg border border-hairline px-3 py-1.5 text-rose-500 hover:bg-rose-50">
                          Disconnect
                        </button>
                      </form>
                    ) : (
                      <form action={useAccount}>
                        <input type="hidden" name="provider" value="email" />
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
          )}
        </div>

        <div className="mt-3 flex items-center justify-between text-sm">
          <span>Run enrichment now (background, priority-first)</span>
          <form action={enrichNowAction}>
            <button className="rounded-lg bg-black px-3 py-1.5 text-sm font-medium text-white hover:bg-black/90">
              Enrich now
            </button>
          </form>
        </div>

        {!unipileOn && (
          <p className="mt-3 text-xs text-amber-600">
            Set UNIPILE_DSN and UNIPILE_API_KEY in Railway to enable LinkedIn linking.
          </p>
        )}
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Integrations</h2>
        <ul className="mt-3 space-y-2 text-sm">
          <li className="flex justify-between">
            Nylas (email + calendar) <Status on={isConfigured("nylas")} />
          </li>
          <li className="flex justify-between">
            Unipile (LinkedIn) <Status on={isConfigured("unipile")} />
          </li>
          <li className="flex justify-between">
            Telegram <Status on={isConfigured("telegram")} />
          </li>
          <li className="flex justify-between">
            Exa.ai (enrichment) <Status on={isConfigured("exa")} />
          </li>
          <li className="flex justify-between">
            Anthropic (LLM) <Status on={isConfigured("llm")} />
          </li>
          <li className="flex justify-between">
            OpenRouter (cheap routing) <Status on={isConfigured("openrouter")} />
          </li>
        </ul>
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Scoring weights</h2>
        <p className="mt-1 text-xs text-muted">
          Normalized automatically. Reply-propensity is now first-class.
        </p>
        <ul className="mt-3 space-y-2 text-sm">
          {WEIGHTS.map(([name, w, desc]) => (
            <li key={name} className="flex items-center justify-between">
              <span>
                {name} <span className="text-muted">— {desc}</span>
              </span>
              <b>{w}%</b>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Background jobs</h2>
        <ul className="mt-3 space-y-1 text-sm">
          {JOBS.map(([name, when]) => (
            <li key={name} className="flex justify-between">
              <span>{name}</span>
              <span className="text-muted">{when}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">
          Heavy work batched overnight; light polling by day — enrich on signal, not on a clock.
        </p>
      </section>
    </div>
  );
}
