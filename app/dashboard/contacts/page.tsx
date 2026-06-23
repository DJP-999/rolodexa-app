import { Suspense } from "react";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, userContext } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { ContactControls } from "./ContactControls";
import { ContactsFilters } from "./ContactsFilters";
import { ContactsTable } from "./ContactsTable";

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

async function getFieldGroupings(): Promise<Record<string, { label: string; categories: string[] }>> {
  try {
    const u = await getPrimaryUser();
    if (!u) return {};
    const row = (
      await db
        .select({ fg: userContext.fieldGroupings })
        .from(userContext)
        .where(eq(userContext.userId, u.id))
        .limit(1)
    )[0];
    return (row?.fg ?? {}) as Record<string, { label: string; categories: string[] }>;
  } catch {
    return {};
  }
}

function days(d: Date | null): string {
  if (!d) return "—";
  return String(Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000));
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    rel?: string;
    tab?: string;
    imported?: string;
    updated?: string;
    added?: string;
    error?: string;
  }>;
}) {
  const sp = await searchParams;
  const [all, fieldGroupings] = await Promise.all([getContacts(), getFieldGroupings()]);
  const enriched = all?.filter((c) => c.enrichedAt).length ?? 0;

  const q = (sp.q ?? "").toLowerCase();
  const rel = sp.rel ?? "";
  const tab = sp.tab ?? "";

  const rows = (all ?? []).filter((c) => {
    if (q) {
      const cf = Object.values((c.customFields ?? {}) as Record<string, string>).join(" ");
      const hay = `${c.name} ${c.company ?? ""} ${c.role ?? ""} ${c.email ?? ""} ${
        c.industry ?? ""
      } ${cf}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (rel && (c.relationship ?? "other") !== rel) return false;
    if (tab === "enriched" && !c.enrichedAt) return false;
    if (tab === "needs" && c.relevance != null) return false;
    return true;
  });

  // Available custom columns across the network (most-populated first).
  const colCounts = new Map<string, number>();
  for (const c of all ?? []) {
    const cf = (c.customFields ?? {}) as Record<string, string>;
    for (const k of Object.keys(cf)) if (cf[k]) colCounts.set(k, (colCounts.get(k) ?? 0) + 1);
  }
  const customFromCsv = [...colCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([key]) => ({ key, label: key }));
  // Derived facet columns (Firm Type, Check Size, Region) aren't raw CSV columns.
  const derivedCols = Object.entries(fieldGroupings)
    .filter(([key]) => !colCounts.has(key))
    .map(([key, g]) => ({ key, label: g.label }));
  const customColumns = [...derivedCols, ...customFromCsv];

  const facets = Object.entries(fieldGroupings).map(([key, g]) => ({
    key,
    label: g.label,
    categories: g.categories,
    multi: g.multi,
  }));

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
        ? `Imported ${sp.imported} new${sp.updated && sp.updated !== "0" ? ` + updated ${sp.updated} existing` : ""} contact${sp.imported === "1" && (!sp.updated || sp.updated === "0") ? "" : "s"}. Enrichment, grading, and column grouping are running in the background — refresh in a bit.`
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
    customFields: (c.customFields ?? {}) as Record<string, string>,
    normalizedFields: (c.normalizedFields ?? {}) as Record<string, string>,
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
        <ContactsTable rows={tableRows} customColumns={customColumns} facets={facets} />
      )}
    </div>
  );
}
