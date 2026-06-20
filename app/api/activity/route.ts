import { NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, jobRuns, claims, suggestions } from "@/db/schema";

export const dynamic = "force-dynamic";

/** Live snapshot for the home activity panel: enrichment progress + recent jobs + events. */
export async function GET() {
  try {
    const cs = await db
      .select({ enrichedAt: contacts.enrichedAt, relevance: contacts.relevance })
      .from(contacts);
    const total = cs.length;
    const enriched = cs.filter((c) => c.enrichedAt).length;
    const graded = cs.filter((c) => c.relevance != null).length;

    const runs = await db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(8);
    const running = runs.some((r) => r.status === "running");

    const jc = await db
      .select()
      .from(claims)
      .where(eq(claims.field, "job_change"))
      .orderBy(desc(claims.observedAt))
      .limit(5);

    const pending = await db
      .select({ c: sql<number>`count(*)` })
      .from(suggestions)
      .where(eq(suggestions.status, "pending"));

    return NextResponse.json({
      progress: { total, enriched, graded, pct: total ? Math.round((enriched / total) * 100) : 0 },
      running,
      runs: runs.map((r) => ({
        name: r.name,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      })),
      jobChanges: jc.map((x) => ({ value: x.value, at: x.observedAt })),
      pendingSuggestions: Number(pending[0]?.c ?? 0),
    });
  } catch {
    return NextResponse.json({
      progress: { total: 0, enriched: 0, graded: 0, pct: 0 },
      running: false,
      runs: [],
      jobChanges: [],
      pendingSuggestions: 0,
    });
  }
}
