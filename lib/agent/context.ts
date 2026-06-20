import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, userContext, suggestions, claims } from "@/db/schema";

type Contact = typeof contacts.$inferSelect;

function fmtContact(c: Contact): string {
  const lastDays = c.lastContactedAt
    ? `${Math.floor((Date.now() - new Date(c.lastContactedAt).getTime()) / 86_400_000)}d ago`
    : "never";
  const roleCo = [c.role, c.company].filter(Boolean).join(" @ ") || "—";
  return `- ${c.name}${c.highValue ? " 🔥" : ""} | ${c.relationship ?? "other"} | ${roleCo} | ${
    c.location ?? "—"
  } | relevance ${c.relevance ?? "—"} | last contacted ${lastDays}`;
}

/**
 * Assemble a bounded, real-data context block for the agent (chat + automations).
 * Never dumps the whole network: top-by-relevance + query-matched contacts +
 * pending suggestions + recent job changes. Keeps tokens (and cost) in check.
 */
export async function buildAgentContext(userId: string, query?: string): Promise<string> {
  const ctx = (
    await db.select().from(userContext).where(eq(userContext.userId, userId)).limit(1)
  )[0];
  const all = await db.select().from(contacts).where(eq(contacts.userId, userId));

  const top = [...all]
    .sort(
      (a, b) =>
        Number(Boolean(b.highValue)) - Number(Boolean(a.highValue)) ||
        (b.relevance ?? 0) - (a.relevance ?? 0),
    )
    .slice(0, 25);

  let matched: Contact[] = [];
  if (query) {
    const toks = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    if (toks.length) {
      matched = all
        .filter((c) => {
          const hay = `${c.name} ${c.company ?? ""} ${c.role ?? ""} ${c.industry ?? ""}`.toLowerCase();
          return toks.some((t) => hay.includes(t));
        })
        .slice(0, 15);
    }
  }

  const pending = await db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.userId, userId), eq(suggestions.status, "pending")))
    .orderBy(desc(suggestions.score))
    .limit(10);
  const byId = new Map(all.map((c) => [c.id, c]));

  const jc = await db
    .select()
    .from(claims)
    .where(eq(claims.field, "job_change"))
    .orderBy(desc(claims.observedAt))
    .limit(8);

  const lines: string[] = [];
  lines.push(`USER ROLE: ${ctx?.role ?? "(not set)"}`);
  if (ctx?.currentFocus) lines.push(`CURRENT FOCUS: ${ctx.currentFocus}`);
  if (ctx?.activeProjects) lines.push(`ACTIVE PROJECTS: ${ctx.activeProjects}`);
  if (ctx?.priorityConnections) lines.push(`PRIORITY PEOPLE: ${ctx.priorityConnections}`);
  lines.push(`TOTAL CONTACTS: ${all.length}`);

  if (matched.length) {
    lines.push(`\nCONTACTS MATCHING THE QUERY:`);
    matched.forEach((c) => lines.push(fmtContact(c)));
  }
  lines.push(`\nTOP CONTACTS BY RELEVANCE:`);
  top.forEach((c) => lines.push(fmtContact(c)));

  if (pending.length) {
    lines.push(`\nPENDING OUTREACH SUGGESTIONS:`);
    pending.forEach((s) => {
      const c = s.contactId ? byId.get(s.contactId) : null;
      lines.push(`- ${c?.name ?? "?"}: ${s.reason}`);
    });
  }
  if (jc.length) {
    lines.push(`\nRECENT JOB CHANGES DETECTED:`);
    jc.forEach((x) => lines.push(`- ${x.value}`));
  }

  return lines.join("\n");
}
