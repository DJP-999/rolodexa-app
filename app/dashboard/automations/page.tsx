export const dynamic = "force-dynamic";

const AUTOMATIONS: [string, string, string][] = [
  ["Morning newsletter", "7:00 AM", "Contacts, pending suggestions, what to act on today."],
  ["Midday update", "12:30 PM", "Delta only — what changed since morning. Silent if nothing did."],
  ["Night brief", "8:00 PM", "Recap vs the morning plan + a preview of tomorrow."],
];

export default function AutomationsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold">Automations</h1>
      <p className="text-sm text-muted">
        Recurring agent tasks — a cron + a prompt. Delivered over Telegram in your timezone.
      </p>
      <div className="mt-6 space-y-3">
        {AUTOMATIONS.map(([name, when, desc]) => (
          <div key={name} className="card flex items-center justify-between">
            <div>
              <div className="font-semibold">{name}</div>
              <div className="text-sm text-muted">{desc}</div>
            </div>
            <span className="chip">{when}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
