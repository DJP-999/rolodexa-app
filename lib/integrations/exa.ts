import { env, isConfigured } from "@/lib/env";

/**
 * Exa adapter — RETRIEVAL ONLY. Returns dated, sourced results; provenance
 * enforcement happens downstream in lib/provenance. Always pass a published-date
 * window so stale pages don't leak.
 */
export type ExaResult = {
  title?: string;
  url: string;
  publishedDate?: string; // PAGE publish date, NOT the event date
  text?: string;
  highlights?: string[];
};

export async function search(opts: {
  query: string;
  startPublishedDate?: string;
  endPublishedDate?: string;
  numResults?: number;
}): Promise<ExaResult[]> {
  if (!isConfigured("exa")) {
    console.warn(`[exa] not configured — skipping search "${opts.query}"`);
    return [];
  }
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": env.EXA_API_KEY! },
    body: JSON.stringify({
      query: opts.query,
      type: "auto",
      numResults: opts.numResults ?? 6,
      startPublishedDate: opts.startPublishedDate,
      endPublishedDate: opts.endPublishedDate,
      contents: { text: true, highlights: true },
    }),
  });
  if (!res.ok) {
    console.error(`[exa] search → ${res.status}`);
    return [];
  }
  const data = (await res.json()) as { results: ExaResult[] };
  return data.results ?? [];
}
