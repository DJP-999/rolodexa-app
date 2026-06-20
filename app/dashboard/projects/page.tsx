import { desc, eq } from "drizzle-orm";
import { Briefcase, Trash2 } from "lucide-react";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { NewProjectButton } from "./NewProjectButton";
import { deleteProject } from "./actions";

export const dynamic = "force-dynamic";

async function getProjects() {
  try {
    const u = await getPrimaryUser();
    if (!u) return [];
    return await db
      .select()
      .from(projects)
      .where(eq(projects.userId, u.id))
      .orderBy(desc(projects.updatedAt));
  } catch {
    return [];
  }
}

export default async function ProjectsPage() {
  const rows = await getProjects();

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight">Projects</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            What you&apos;re working toward. Dexa uses these as context when ranking who to reach out
            to and when answering in chat.
          </p>
        </div>
        <NewProjectButton />
      </div>

      {rows.length === 0 ? (
        <div className="mt-6 flex flex-col items-center justify-center rounded-2xl border border-hairline bg-white py-20 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-black/[0.04]">
            <Briefcase className="h-5 w-5 text-muted" />
          </div>
          <div className="mt-4 text-[15px] font-medium text-ink">No projects yet</div>
          <p className="mt-1 max-w-sm text-sm text-muted">
            Create one to give Dexa richer context about your active deals and raises.
          </p>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {rows.map((p) => (
            <div key={p.id} className="card">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-lg font-semibold text-ink">{p.name}</h3>
                <form action={deleteProject}>
                  <input type="hidden" name="id" value={p.id} />
                  <button
                    title="Delete"
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-hairline text-rose-500 hover:bg-rose-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </form>
              </div>
              {p.oneLiner && <p className="mt-1 text-sm text-muted">{p.oneLiner}</p>}
              {p.memoryDoc && (
                <p className="mt-3 whitespace-pre-wrap text-sm text-ink/80">{p.memoryDoc}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
