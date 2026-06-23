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
  // Lazily-generated contact bio shown on the profile page.
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "summary" text`);
  // Deep LinkedIn profile (career, education, skills) for priority contacts.
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "profile_data" jsonb`);
  // Why-this-why-now reasoning shown with each suggestion.
  await sql.unsafe(`ALTER TABLE "suggestions" ADD COLUMN IF NOT EXISTS "rationale" text`);
  // Writing-style learning state: auto vs manual, how many samples it learned from, and when.
  await sql.unsafe(
    `ALTER TABLE "user_context" ADD COLUMN IF NOT EXISTS "writing_style_source" text DEFAULT 'auto'`,
  );
  await sql.unsafe(
    `ALTER TABLE "user_context" ADD COLUMN IF NOT EXISTS "writing_style_samples" integer DEFAULT 0`,
  );
  await sql.unsafe(
    `ALTER TABLE "user_context" ADD COLUMN IF NOT EXISTS "writing_style_updated_at" timestamptz`,
  );
  // X (Twitter) handle/id cache per contact + when we last looked.
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "x_handle" text`);
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "x_user_id" text`);
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "x_checked_at" timestamptz`);
  // When a suggestion was pushed (digest or breaking ping) so we never double-send it.
  await sql.unsafe(`ALTER TABLE "suggestions" ADD COLUMN IF NOT EXISTS "notified_at" timestamptz`);
  // LinkedIn member id per contact, so approved outreach can be sent as a DM.
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "linkedin_member_id" text`);
  // Full imported CSV columns (raw) + Dexa's normalized canonical values per contact.
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "custom_fields" jsonb DEFAULT '{}'::jsonb`);
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "normalized_fields" jsonb DEFAULT '{}'::jsonb`);
  // Per-column grouping config (label + canonical category list) used for facets.
  await sql.unsafe(`ALTER TABLE "user_context" ADD COLUMN IF NOT EXISTS "field_groupings" jsonb DEFAULT '{}'::jsonb`);
  console.log("[db] ensureSchema applied.");
}
