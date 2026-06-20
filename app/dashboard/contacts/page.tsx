import { Suspense } from "react";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { ContactControls } from "./ContactControls";
import { ContactsFilters } from "./ContactsFilters";
import { ContactsTableBody } from "./ContactsTableBody";

export const dynamic = "force-dynamic";

async function getContacts() {
  try {
    return await db
      .select()
      .from(contacts)
      .orderBy(sql`${contacts.highValue} desc nulls last, ${contacts.relevance} desc nulls last`)
      .limit(500);
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

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    rel?: string;
    tab?: string;
    imported?: string;
    added?: string;
    error?: string;
  }>;
}) {
  const sp = await searchParams;
  const all = await getContacts();
  const enriched = all?.filter((c) => c.enrichedAt).length ?? 0;

  const q = (sp.q ?? "").toLowerCase();
  const rel = sp.rel ?? "";
  const tab = sp.tab ?? "";

  const rows = (all ?? []).filter((c) => {
    if (q) {
      const hay = `${c.name} ${c.company ?? ""} ${c.role ?? ""} ${c.email ?? ""} ${
        c.industry ?? ""
      }`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (rel && (c.relationship ?? "other") !== rel) return false;
    if (tab === "enriched" && !c.enrichedAt) return false;
    if (tab === "needs" && c.relevance != null) return false;
    return true;
  });

  const banner =
    sp.error != null
      ? `Import failed: ${
          sp.error === "noheader"
            ? "couldn't find a header row — your CSV needs a Name or Email column."
            : sp.error === "nofile"
              ? "no file selected."
              : sp.error === "noname"
                ? "a name is required."
                : sp.error
        }`
      : sp.imported != null
        ? `Imported ${sp.imported} new contact${sp.imported === "1" ? "" : "s"}. Enrichment + grading are running in the background — refresh in a bit.`
        : sp.added
          ? "Contact added and your network re-graded."
          : null;

  const tableRows = rows.map((c) => ({
    id: c.id,
    name: c.name,
    role: c.role,
    company: c.company,
    industry: c.industry,
    location: c.location,
    relationship: c.relationship,
    relevance: c.relevance,
    status: c.status,
    highValue: c.highValue,
    lastDays: days(c.lastContactedAt),
  }));

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight">Contacts</h1>
          <p className="mt-1 text-sm text-muted">{all?.length ?? 0} contacts</p>
        </div>
        <ContactControls />
      </div>

      {banner && (
        <div
          className={`mt-4 rounded-lg px-4 py-2.5 text-sm ${
            sp.error ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"
          }`}
        >
          {banner}
        </div>
      )}

      <Suspense fallback={<div className="mt-5 h-[88px]" />}>
        <ContactsFilters enriched={enriched} />
      </Suspense>

      {!all ? (
        <p className="mt-8 text-sm text-muted">Connect the database to see contacts.</p>
      ) : rows.length === 0 ? (
        <p className="mt-8 text-sm text-muted">
          No contacts match. Import a CSV or add one to get started.
        </p>
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
            <ContactsTableBody rows={tableRows} />
          </table>
        </div>
      )}
    </div>
  );
}
