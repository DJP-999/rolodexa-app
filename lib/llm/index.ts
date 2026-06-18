import Anthropic from "@anthropic-ai/sdk";
import { env, isConfigured } from "@/lib/env";

/**
 * Provider-agnostic LLM surface with explicit cost routing.
 *   tier "cheap"  → triage / classification / "is this worth surfacing"
 *   tier "strong" → drafts, grade rationales, intro reasoning
 * If the key is unset, calls return a stub so the worker runs without tokens.
 */
export type Tier = "cheap" | "strong";
export type ChatMessage = { role: "user" | "assistant"; content: string };

const client = isConfigured("llm") ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY! }) : null;

function modelFor(tier: Tier): string {
  return tier === "strong" ? env.LLM_MODEL_STRONG : env.LLM_MODEL_CHEAP;
}

export async function complete(opts: {
  tier: Tier;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  if (!client) {
    return `[llm-stub:${opts.tier}] (set ANTHROPIC_API_KEY to enable).`;
  }
  const res = await client.messages.create({
    model: modelFor(opts.tier),
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
