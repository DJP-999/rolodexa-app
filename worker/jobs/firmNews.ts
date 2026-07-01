import { sweepFirmNews } from "@/lib/research/firmNews";
import { reportProgress } from "@/lib/jobs/progress";

/**
 * Firm-news sweep job. Rotates through every watched firm (stalest first), one categorized
 * web search per FIRM (not per contact), stores validated items in firm_news, and fans them
 * out as sourced claims — which the next suggestions/news-scan run converts into outreach.
 * Scheduled ahead of each news-scan run so fresh firm claims ride the same conversion pass.
 */
export async function runFirmNews(): Promise<void> {
  const { firms, items, claimsWritten } = await sweepFirmNews((done, total) => {
    void reportProgress(done, total, "Sweeping firm news");
  });
  console.log(`[firm-news] swept ${firms} firm(s): ${items} item(s), ${claimsWritten} claim(s)`);
}
