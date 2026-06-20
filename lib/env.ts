import { z } from "zod";

/**
 * Typed environment. Integration keys are OPTIONAL so the foundation boots
 * without them; `isConfigured()` lets each adapter degrade to a logged no-op.
 */
const schema = z.object({
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  APP_BASE_URL: z.string().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL_CHEAP: z.string().default("claude-haiku-4-5-20251001"),
  LLM_MODEL_STRONG: z.string().default("claude-sonnet-4-6"),
  LLM_MONTHLY_BUDGET_USD: z.coerce.number().default(200),

  NYLAS_API_KEY: z.string().optional(),
  NYLAS_API_URI: z.string().default("https://api.us.nylas.com"),
  NYLAS_CLIENT_ID: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  EXA_API_KEY: z.string().optional(),

  X_BEARER_TOKEN: z.string().optional(),

  UNIPILE_DSN: z.string().optional(),
  UNIPILE_API_KEY: z.string().optional(),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL_CHEAP: z.string().default("openai/gpt-4o-mini"),

  AUTH_SECRET: z.string().optional(),
  AUTH_DEV_USER_EMAIL: z.string().default("dev@rolodexa.local"),

  ENRICH_ONLY_ON_SIGNAL: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  ENRICH_STALE_AFTER_DAYS: z.coerce.number().default(30),
  NEWS_FRESHNESS_DAYS: z.coerce.number().default(31),
  ENRICH_NEWS_DAYS_ONGOING: z.coerce.number().default(7),
  ENRICH_DAILY_LINKEDIN_CAP: z.coerce.number().default(120),
  ENRICH_MONTHLY_BUDGET_USD: z.coerce.number().default(40),
});

export const env = schema.parse(process.env);

export type Integration = "nylas" | "telegram" | "exa" | "llm" | "unipile" | "openrouter" | "x";

export function isConfigured(which: Integration): boolean {
  switch (which) {
    case "nylas":
      return Boolean(env.NYLAS_API_KEY);
    case "telegram":
      return Boolean(env.TELEGRAM_BOT_TOKEN);
    case "exa":
      return Boolean(env.EXA_API_KEY);
    case "llm":
      return Boolean(env.ANTHROPIC_API_KEY);
    case "unipile":
      return Boolean(env.UNIPILE_DSN && env.UNIPILE_API_KEY);
    case "openrouter":
      return Boolean(env.OPENROUTER_API_KEY);
    case "x":
      return Boolean(env.X_BEARER_TOKEN);
  }
}
