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
  // Optional: route the STRONG tier via OpenRouter (e.g. "z-ai/glm-5.2"). Falls back to the
  // cheap model if unset. Set LLM_STRONG_PROVIDER=openrouter to make it the primary for drafts.
  OPENROUTER_MODEL_STRONG: z.string().optional(),
  LLM_STRONG_PROVIDER: z.enum(["anthropic", "openrouter"]).default("anthropic"),

  AUTH_SECRET: z.string().optional(),
  AUTH_DEV_USER_EMAIL: z.string().default("dev@rolodexa.local"),

  ENRICH_ONLY_ON_SIGNAL: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  ENRICH_STALE_AFTER_DAYS: z.coerce.number().default(30),
  NEWS_FRESHNESS_DAYS: z.coerce.number().default(31),
  ENRICH_NEWS_DAYS_ONGOING: z.coerce.number().default(7),
  // News sweep coverage: anyone whose thesis-fit clears this floor is "valuable to the user's
  // goals" and gets swept (not just a top-N). Rotated stalest-first, NEWS_SCAN_BATCH per run.
  NEWS_FIT_FLOOR: z.coerce.number().default(0.45),
  NEWS_SCAN_BATCH: z.coerce.number().default(60),
  // Max NEW firms to web-research per fit-grade run (cached firms are free). Bounds Exa+LLM
  // cost; coverage converges across runs as the per-firm cache fills. Investors first.
  FIRM_RESEARCH_CAP: z.coerce.number().default(150),
  // Set to a contact's name to print targeted diagnostics in the message-backfill job
  // (does their chat exist in the synced set, and why did/didn't it attribute). Leave unset normally.
  DEBUG_BACKFILL_NAME: z.string().optional(),
  // How deep the message backfill paginates the LinkedIn inbox. Newest-first, so older
  // relationships (most of the rolodex) need a high ceiling to be reached.
  MESSAGE_BACKFILL_CHAT_CAP: z.coerce.number().default(8000),
  MESSAGE_BACKFILL_ATTENDEE_LOOKUPS: z.coerce.number().default(800),
  // How many recent emails the 30-min poll paginates through (across all folders incl. Sent),
  // so a busy mailbox doesn't truncate recent mail to a single 250-item page.
  EMAIL_POLL_CAP: z.coerce.number().default(1500),
  ENRICH_DAILY_LINKEDIN_CAP: z.coerce.number().default(120),
  ENRICH_MONTHLY_BUDGET_USD: z.coerce.number().default(40),

  // Apify-powered bulk LinkedIn profile enrichment (no per-account rate limit).
  // Set APIFY_TOKEN to enable; the actor id uses Apify's "username~actor-name" form.
  APIFY_TOKEN: z.string().optional(),
  APIFY_ACTOR_ID: z.string().default("harvestapi~linkedin-profile-scraper"),
  APIFY_URLS_FIELD: z.string().default("queries"), // the actor's profile-URL array field
  APIFY_PROFILE_MODE: z.string().default("Profile details no email ($4 per 1k)"),
  APIFY_ACTOR_INPUT: z.string().optional(), // optional JSON of extra static actor input
  APIFY_PROFILE_DAILY_CAP: z.coerce.number().default(500),
  // Search actor — resolves URL-less contacts by name + company, then enriches in one shot.
  APIFY_SEARCH_ACTOR_ID: z.string().default("harvestapi~linkedin-profile-search"),
  APIFY_SEARCH_MODE: z.string().default("Full ($0.1 per search page + $0.004 per full profile)"),
  APIFY_SEARCH_INPUT: z.string().optional(),
  APIFY_RESOLVE_DAILY_CAP: z.coerce.number().default(150),
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
