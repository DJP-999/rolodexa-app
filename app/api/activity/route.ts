import { NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, jobRuns, claims, suggestions } from "@/db/schema";

export const dynamic = "force-dynamic";

const FIVE_MIN = 5 * 60 * 1000;

/** Live snapshot for the home activity panel + Rolodex progress bar:
 *  enrichment/scoring progress, live throughput, the running job, and recent runs. */
export async function GET() {
  try {
    const cs = await db
      .select({
        enrichedAt: contacts.enrichedAt,
        relevance: contacts.relevance,
        professionalFit: contacts.professionalFit,
        gradedAt: contacts.gradedAt,
        relationship: contacts.relationship,
      })
      .from(contacts);
    const total = cs.length;
    const now = Date.now();
    const since = now - FIVE_MIN;
    const enriched = cs.filter((c) => c.enrichedAt).length;
    const scored = cs.filter((c) => c.relevance != null).length;
    const fitGraded = cs.filter((c) => c.professionalFit != null).length;
    const categorized = cs.filter((c) => c.relationship && c.relationship !== "other").length;
    const gradedLast5m = cs.filter((c) => c.gradedAt && new Date(c.gradedAt).getTime() > since).length;
    const enrichedLast5m = cs.filter((c) => c.enrichedAt && new Date(c.enrichedAt).getTime() > since).length;

    const runs = await db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(10);
    const current = runs.find((r) => r.status === "running") ?? null;

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

    const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);

    return NextResponse.json({
      progress: {
        total,
        enriched,
        scored,
        fitGraded,
        categorized,
        enrichedPct: pct(enriched),
        scoredPct: pct(scored),
        fitPct: pct(fitGraded),
        categorizedPct: pct(categorized),
      },
      recent: { gradedLast5m, enrichedLast5m },
      running: !!current,
      current: current
        ? {
            name: current.name,
            startedAt: current.startedAt,
            // Live per-job progress written by the job into its run row (processed/total/pct/etaMs/phase).
            progress:
              current.detail && typeof current.detail === "object" && "total" in current.detail
                ? (current.detail as Record<string, unknown>)
                : null,
          }
        : null,
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
      progress: { total: 0, enriched: 0, scored: 0, fitGraded: 0, categorized: 0, enrichedPct: 0, scoredPct: 0, fitPct: 0, categorizedPct: 0 },
      recent: { gradedLast5m: 0, enrichedLast5m: 0 },
      running: false,
      current: null,
      runs: [],
      jobChanges: [],
      pendingSuggestions: 0,
    });
  }
}
