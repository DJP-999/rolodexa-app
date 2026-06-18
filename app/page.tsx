import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-20">
      <span className="chip">Rebuild · Phase 0</span>
      <h1 className="mt-4 text-5xl font-bold tracking-tight">Rolodexa</h1>
      <p className="mt-3 max-w-xl text-lg text-muted">
        Stay close to your relationships at scale — so you&apos;re not reaching out only when you
        need something. Proactive, provenance-first, and quiet by default.
      </p>
      <div className="mt-6 flex gap-3">
        <Link
          href="/dashboard"
          className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white"
        >
          Open dashboard
        </Link>
        <Link
          href="/onboarding"
          className="rounded-lg border border-hairline px-4 py-2 text-sm font-medium"
        >
          Start onboarding
        </Link>
      </div>

      <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {[
          ["Know your network", "Behavioral reply-propensity + sourced enrichment, graded transparently."],
          ["Proactive, not noisy", "A ≤3/day precision gate. Quiet days send nothing."],
          ["Never hallucinate", "Event-date provenance + an output-verification pass before anything sends."],
          ["Cheap to run", "Enrich on signal, not on a clock. Cheap model triages; strong model drafts."],
        ].map(([t, d]) => (
          <div key={t} className="card">
            <h3 className="font-semibold">{t}</h3>
            <p className="mt-1 text-sm text-muted">{d}</p>
          </div>
        ))}
      </div>
    </main>
  );
}
