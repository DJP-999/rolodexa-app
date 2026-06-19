import { Briefcase } from "lucide-react";

export const dynamic = "force-dynamic";

export default function ProjectsPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight">Projects</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            What you&apos;re working toward. Dexa keeps each project&apos;s memory doc current as
            things happen — you can edit anything.
          </p>
        </div>
        <button className="rounded-lg bg-black px-3.5 py-2 text-sm font-medium text-white">
          + New project
        </button>
      </div>

      <div className="mt-6 flex flex-col items-center justify-center rounded-2xl border border-hairline bg-white py-20 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-black/[0.04]">
          <Briefcase className="h-5 w-5 text-muted" />
        </div>
        <div className="mt-4 text-[15px] font-medium text-ink">No projects yet</div>
        <p className="mt-1 max-w-sm text-sm text-muted">
          Tell Dexa what you&apos;re working on in chat — or create one here — and it will keep the
          project&apos;s context up to date for you.
        </p>
      </div>
    </div>
  );
}
