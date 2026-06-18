export const dynamic = "force-dynamic";

export default function ProjectsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold">Projects</h1>
      <p className="text-sm text-muted">
        What you&apos;re working toward. Each project is a living memory doc the agent keeps current
        — and the query the &quot;Reconnect&quot; engine matches your dormant contacts against
        (Phase 1).
      </p>
      <div className="card mt-6 text-sm text-muted">No projects yet.</div>
    </div>
  );
}
