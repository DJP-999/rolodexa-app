import Anthropic from "@anthropic-ai/sdk";
import { env, isConfigured } from "@/lib/env";

/**
 * Provider-routed LLM surface with explicit cost control.
 *   cheap  → OpenRouter (a sub-cent bulk model) first, Anthropic Haiku fallback.
 *            Used for triage, CSV column-mapping, batched categorization, extraction.
 *   strong → Anthropic Sonnet first, OpenRouter fallback. Used for drafts and
 *            top-tier dossiers.
 * Unset keys degrade to a stub so the app runs without tokens.
 */
export type Tier = "cheap" | "strong";
export type ChatMessage = { role: "user" | "assistant"; content: string };

type Opts = {
  tier: Tier;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
};

const anthropic = isConfigured("llm") ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY! }) : null;

async function viaAnthropic(tier: Tier, opts: Opts): Promise<string | null> {
  if (!anthropic) return null;
  try {
    const res = await anthropic.messages.create({
      model: tier === "strong" ? env.LLM_MODEL_STRONG : env.LLM_MODEL_CHEAP,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.4,
      system: opts.system,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch (e) {
    console.error("[anthropic]", e);
    return null;
  }
}

async function viaOpenRouter(opts: Opts): Promise<string | null> {
  if (!isConfigured("openrouter")) return null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "X-Title": "Rolodexa",
      },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL_CHEAP,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.4,
        messages: [
          ...(opts.system ? [{ role: "system", content: opts.system }] : []),
          ...opts.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      }),
    });
    if (!res.ok) {
      console.error(`[openrouter] ${res.status}`);
      return null;
    }
    const data: any = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === "string" ? text.trim() : null;
  } catch (e) {
    console.error("[openrouter]", e);
    return null;
  }
}

export async function complete(opts: Opts): Promise<string> {
  const order =
    opts.tier === "cheap"
      ? [() => viaOpenRouter(opts), () => viaAnthropic("cheap", opts)]
      : [() => viaAnthropic("strong", opts), () => viaOpenRouter(opts)];
  for (const attempt of order) {
    const r = await attempt();
    if (r != null && r.length > 0) return r;
  }
  return `[llm-stub:${opts.tier}] (configure ANTHROPIC_API_KEY or OPENROUTER_API_KEY).`;
}

export async function extractJSON<T>(opts: {
  tier: Tier;
  system?: string;
  instruction: string;
  fallback: T;
}): Promise<T> {
  const raw = await complete({
    tier: opts.tier,
    system: opts.system,
    messages: [{ role: "user", content: opts.instruction + "\n\nRespond with JSON only." }],
    maxTokens: 1024,
  });
  const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) return opts.fallback;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return opts.fallback;
  }
}
