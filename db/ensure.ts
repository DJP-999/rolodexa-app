/**
 * Idempotent incremental DDL for schema additions not covered by the generated
 * Drizzle migrations (which can't be regenerated in this build environment).
 * Safe to run on every deploy. Each statement must be individually idempotent.
 */
export async function ensureSchema(sql: {
  unsafe: (q: string) => Promise<unknown>;
}): Promise<void> {
  // LinkedIn message interactions need a 'linkedin' value on the channel enum.
  // ADD VALUE IF NOT EXISTS runs as its own (auto-committed) statement.
  await sql.unsafe(`ALTER TYPE "channel" ADD VALUE IF NOT EXISTS 'linkedin'`);
  // Learned outreach voice, used to draft proactive messages in the user's style.
  await sql.unsafe(`ALTER TABLE "user_context" ADD COLUMN IF NOT EXISTS "writing_style" text`);
  // Whether the first (month-window) enrichment has run; later runs use the week window.
  await sql.unsafe(
    `ALTER TABLE "user_context" ADD COLUMN IF NOT EXISTS "first_enrich_done" boolean DEFAULT false`,
  );
  console.log("[db] ensureSchema applied.");
}
