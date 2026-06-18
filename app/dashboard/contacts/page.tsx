import { desc } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema";

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

export default async function ContactsPage() {
  const rows = await getContacts();
  if (!rows) {
    return <p className="text-sm text-muted">Connect the database to see contacts.</p>;
  }
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-3xl font-bold">Contacts</h1>
      <p className="text-sm text-muted">{rows.length} contacts</p>

      <div className="card mt-6 overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-hairline text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Company</th>
              <th className="px-4 py-3">Relationship</th>
              <th className="px-4 py-3">Relevance</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Days</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-b border-hairline/60 hover:bg-surface">
                <td className="px-4 py-3">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-muted">{c.role ?? "—"}</div>
                </td>
                <td className="px-4 py-3 text-muted">{c.company ?? "—"}</td>
                <td className="px-4 py-3">
                  <span className="chip capitalize">{c.relationship ?? "other"}</span>
                </td>
                <td className="px-4 py-3 font-medium">{c.relevance ?? "—"}</td>
                <td className="px-4 py-3 capitalize text-muted">
                  {(c.status ?? "—").replace("_", " ")}
                </td>
                <td className="px-4 py-3 text-muted">{days(c.lastContactedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
