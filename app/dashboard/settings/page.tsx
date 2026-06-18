import { isConfigured } from "@/lib/env";

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

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-sm text-muted">Scoring weights, connections, and background jobs.</p>
      </div>

      <section className="card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Integrations</h2>
        <ul className="mt-3 space-y-2 text-sm">
          <li className="flex justify-between">Nylas (email + calendar) <Status on={isConfigured("nylas")} /></li>
          <li className="flex justify-between">Telegram <Status on={isConfigured("telegram")} /></li>
          <li className="flex justify-between">Exa.ai (enrichment) <Status on={isConfigured("exa")} /></li>
          <li className="flex justify-between">Anthropic (LLM) <Status on={isConfigured("llm")} /></li>
        </ul>
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Scoring weights</h2>
        <p className="mt-1 text-xs text-muted">Normalized automatically. Reply-propensity is now first-class.</p>
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
