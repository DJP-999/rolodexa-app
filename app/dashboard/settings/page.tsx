import { isConfigured } from "@/lib/env";
import { getPrimaryUser, getUserContextRow } from "@/lib/user";
import { saveContextAction } from "./actions";

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

async function getContext() {
  try {
    const user = await getPrimaryUser();
    if (!user) return null;
    return await getUserContextRow(user.id);
  } catch {
    return null;
  }
}

const inputCls =
  "mt-1.5 w-full rounded-lg border border-hairline bg-white px-3 py-2 text-sm outline-none focus:border-black/30";

export default async function SettingsPage() {
  const ctx = await getContext();

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-sm text-muted">Your context, scoring weights, connections, and jobs.</p>
      </div>

      <section className="card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Your context</h2>
        <p className="mt-1 text-xs text-muted">
          This is the single biggest driver of who Rolodexa surfaces. Tell it what you&apos;re
          working on and who matters — it re-grades your whole network on save.
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
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Integrations</h2>
        <ul className="mt-3 space-y-2 text-sm">
          <li className="flex justify-between">
            Nylas (email + calendar) <Status on={isConfigured("nylas")} />
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
