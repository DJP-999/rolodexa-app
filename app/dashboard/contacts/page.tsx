import { desc } from "drizzle-orm";
import { Search, SlidersHorizontal } from "lucide-react";
import { db } from "@/db";
import { contacts, type Contact } from "@/db/schema";

export const dynamic = "force-dynamic";

async function getContacts() {
  try {
    return await db.select().from(contacts).orderBy(desc(contacts.relevance)).limit(200);
  } catch {
    return null;
  }
}

function days(d: Date | null): string {
  if (!d) return "—";
  return String(Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000));
}

const REL_BADGE: Record<string, string> = {
  investor: "bg-violet-100 text-violet-700",
  friend: "bg-rose-100 text-rose-700",
  coworker: "bg-sky-100 text-sky-700",
  vendor: "bg-amber-100 text-amber-700",
  family: "bg-emerald-100 text-emerald-700",
  other: "bg-black/[0.05] text-muted",
};
const DOT: Record<string, string> = {
  active: "bg-emerald-500",
  warming: "bg-emerald-500",
  going_cold: "bg-amber-400",
  dormant: "bg-gray-300",
};

function meterColor(r: number | null): string {
  if (r == null) return "#d1d5db";
  if (r >= 70) return "#22c55e";
  if (r >= 50) return "#f59e0b";
  return "#f59e0b";
}

function Cell({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-3.5 align-top text-[13px] text-muted">{children}</td>;
}

export default async function ContactsPage() {
  const rows = await getContacts();
  const enriched = rows?.filter((c) => c.enrichedAt).length ?? 0;

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-[28px] font-bold tracking-tight">Contacts</h1>
      <p className="mt-1 text-sm text-muted">{rows?.length ?? 0} contacts</p>

      {/* search + category filters */}
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <div className="flex w-[340px] items-center gap-2 rounded-xl border border-hairline bg-white px-3 py-2.5">
          <Search className="h-4 w-4 text-muted" />
          <input
            placeholder="Search contacts..."
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted"
          />
        </div>
        <SlidersHorizontal className="h-4 w-4 text-muted" />
        <div className="flex items-center gap-1 text-sm">
          <span className="rounded-full bg-black px-3 py-1 font-medium text-white">All</span>
          {["Coworker", "Friend", "Investor", "Other", "Vendor"].map((c) => (
            <span key={c} className="cursor-pointer rounded-full px-3 py-1 text-muted hover:text-ink">
              {c}
            </span>
          ))}
        </div>
      </div>

      {/* status tabs */}
      <div className="mt-4 flex items-center gap-1 text-sm">
        <span className="rounded-full bg-black px-3 py-1 font-medium text-white">All</span>
        <span className="flex items-center gap-1.5 rounded-full px-3 py-1 text-muted">
          Enriched <span className="chip">{enriched}</span>
        </span>
        <span className="rounded-full px-3 py-1 text-muted">Needs Context</span>
        <span className="rounded-full px-3 py-1 text-muted">Dismissed</span>
      </div>

      {!rows ? (
        <p className="mt-8 text-sm text-muted">Connect the database to see contacts.</p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-2xl border border-hairline bg-white">
          <table className="w-full">
            <thead>
              <tr className="border-b border-hairline text-left text-xs text-muted">
                <th className="px-3 py-3 font-normal">Name</th>
                <th className="px-3 py-3 font-normal">Company</th>
                <th className="px-3 py-3 font-normal">Industry</th>
                <th className="px-3 py-3 font-normal">Location</th>
                <th className="px-3 py-3 font-normal">Relationship</th>
                <th className="px-3 py-3 font-normal">Relevance</th>
                <th className="px-3 py-3 font-normal">Days</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c: Contact) => (
                <tr key={c.id} className="border-b border-hairline/70 hover:bg-black/[0.015]">
                  <td className="px-3 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-black/[0.05] text-xs font-medium text-muted">
                          {c.name.charAt(0).toUpperCase()}
                        </div>
                        <span
                          className={`absolute -bottom-0.5 left-0 h-2.5 w-2.5 rounded-full border-2 border-white ${DOT[c.status ?? "active"]}`}
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-sm font-medium text-ink">
                          {c.name} {c.highValue ? "🔥" : ""}
                        </div>
                        <div className="text-xs text-muted">{c.role ?? "—"}</div>
                      </div>
                    </div>
                  </td>
                  <Cell>{c.company ?? "—"}</Cell>
                  <Cell>{c.industry ?? "—"}</Cell>
                  <Cell>{c.location ?? "—"}</Cell>
                  <td className="px-3 py-3.5">
                    <span
                      className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium capitalize ${REL_BADGE[c.relationship ?? "other"]}`}
                    >
                      {c.relationship ?? "other"}
                    </span>
                  </td>
                  <td className="px-3 py-3.5">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-hairline">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${c.relevance ?? 0}%`,
                            backgroundColor: meterColor(c.relevance),
                          }}
                        />
                      </div>
                      <span className="text-[13px] font-medium text-ink">{c.relevance ?? "—"}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3.5 text-[13px] font-medium text-emerald-600">
                    {days(c.lastContactedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
