import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { coldProspects, type ColdProspect } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { isNoiseEmail } from "@/lib/sync/noise";
import { promoteColdAction, blacklistColdAction } from "./actions";

export const dynamic = "force-dynamic";

const GHOST_DAYS = 7;

type Display = "messaged" | "replied" | "meeting_set" | "ghosted" | "promoted";

/** Derive the shown status: a 'messaged' prospect with no reply after N days reads as ghosted. */
function displayStatus(p: ColdProspect): Display {
  if (p.status === "promoted") return "promoted";
  if (p.status === "meeting_set") return "meeting_set";
  if (p.status === "replied") return "replied";
  const last = p.lastOutboundAt ? new Date(p.lastOutboundAt).getTime() : null;
  if (last && Date.now() - last > GHOST_DAYS * 86_400_000) return "ghosted";
  return "messaged";
}

const BADGE: Record<Display, string> = {
  messaged: "bg-sky-100 text-sky-700",
  replied: "bg-emerald-100 text-emerald-700",
  meeting_set: "bg-violet-100 text-violet-700",
  ghosted: "bg-rose-100 text-rose-600",
  promoted: "bg-amber-100 text-amber-700",
};
const LABEL: Record<Display, string> = {
  messaged: "Messaged",
  replied: "Replied",
  meeting_set: "Meeting set",
  ghosted: "Ghosted",
  promoted: "Promoted",
};

function fmt(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

async function getProspects() {
  const u = await getPrimaryUser();
  if (!u) return null;
  try {
    return await db
      .select()
      .from(coldProspects)
      .where(eq(coldProspects.userId, u.id))
      .orderBy(desc(coldProspects.updatedAt))
      .limit(1000);
  } catch {
    return [];
  }
}

export default async function ColdOutreachPage() {
  const rows = await getProspects();
  const list = (rows ?? []).filter((p) => !isNoiseEmail(p.email));
  const counts = list.reduce<Record<string, number>>((a, p) => {
    const s = displayStatus(p);
    a[s] = (a[s] ?? 0) + 1;
    return a;
  }, {});

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-[28px] font-bold tracking-tight">Cold Outreach</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        People you&apos;ve reached out to who aren&apos;t in your rolodex yet — tracked separately. They
        graduate into Contacts automatically when a meeting is set, or promote one yourself anytime.
      </p>

      {rows === null ? (
        <p className="mt-8 text-sm text-muted">Connect the database to see cold outreach.</p>
      ) : list.length === 0 ? (
        <p className="mt-8 text-sm text-muted">
          No cold prospects yet. Outbound email or LinkedIn messages to people not in your rolodex will
          appear here automatically.
        </p>
      ) : (
        <>
          <div className="mt-5 flex flex-wrap gap-2 text-xs">
            {(["messaged", "replied", "meeting_set", "ghosted", "promoted"] as Display[]).map((s) => (
              <span key={s} className={`rounded-md px-2.5 py-1 font-medium ${BADGE[s]}`}>
                {LABEL[s]}: {counts[s] ?? 0}
              </span>
            ))}
          </div>

          <div className="mt-4 overflow-x-auto rounded-2xl border border-hairline bg-white">
            <table className="w-full">
              <thead>
                <tr className="border-b border-hairline text-left text-xs text-muted">
                  <th className="px-3 py-3 font-normal">Prospect</th>
                  <th className="px-3 py-3 font-normal">Channel</th>
                  <th className="px-3 py-3 font-normal">Status</th>
                  <th className="px-3 py-3 font-normal">First outreach</th>
                  <th className="px-3 py-3 font-normal">Last activity</th>
                  <th className="px-3 py-3 font-normal">Out / In</th>
                  <th className="px-3 py-3 font-normal" />
                </tr>
              </thead>
              <tbody>
                {list.map((p) => {
                  const s = displayStatus(p);
                  const lastAct =
                    [p.lastInboundAt, p.lastOutboundAt, p.meetingAt]
                      .filter(Boolean)
                      .map((d) => new Date(d as Date).getTime())
                      .sort((a, b) => b - a)[0] ?? null;
                  return (
                    <tr key={p.id} className="border-b border-hairline/70">
                      <td className="px-3 py-3">
                        <div className="text-sm font-medium text-ink">{p.name || p.email || "Unknown"}</div>
                        <div className="text-xs text-muted">{p.email || (p.linkedinMemberId ? "LinkedIn" : "")}</div>
                      </td>
                      <td className="px-3 py-3 text-[13px] capitalize text-muted">
                        {p.channel === "linkedin" ? "LinkedIn" : "Email"}
                      </td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${BADGE[s]}`}>
                          {LABEL[s]}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-[13px] text-muted">{fmt(p.firstOutreachAt)}</td>
                      <td className="px-3 py-3 text-[13px] text-muted">{fmt(lastAct ? new Date(lastAct) : null)}</td>
                      <td className="px-3 py-3 text-[13px] text-muted">
                        {p.outboundCount ?? 0} / {p.inboundCount ?? 0}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          {p.status === "promoted" ? (
                            <span className="text-xs text-muted">In rolodex</span>
                          ) : (
                            <form action={promoteColdAction}>
                              <input type="hidden" name="id" value={p.id} />
                              <button className="rounded-lg border border-hairline px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-black/[0.03]">
                                Promote
                              </button>
                            </form>
                          )}
                          <form action={blacklistColdAction}>
                            <input type="hidden" name="id" value={p.id} />
                            <button
                              title="Stop tracking this sender and remove it"
                              className="rounded-lg border border-hairline px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-rose-50 hover:text-rose-600"
                            >
                              Blacklist
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
