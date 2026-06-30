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
  // LLM-graded domain/thesis fit (0..1) of a contact to the user's focus — drives relevance.
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "professional_fit" real`);
  // PitchBook firm intel matched onto a contact (separate from the user's own fields).
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "pitchbook_data" jsonb`);
  // Separate reference table for imported PitchBook firms/investors (never mixed with contacts).
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS "pitchbook_firms" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "name_key" text NOT NULL,
    "custom_fields" jsonb DEFAULT '{}'::jsonb,
    "normalized_fields" jsonb DEFAULT '{}'::jsonb,
    "created_at" timestamptz NOT NULL DEFAULT now()
  )`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS "pb_firms_user_idx" ON "pitchbook_firms" ("user_id")`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS "pb_firms_key_idx" ON "pitchbook_firms" ("user_id","name_key")`);
  // KPI tracking: richer interaction attribution (replies, counterparty identity, cold link).
  await sql.unsafe(`ALTER TABLE "interactions" ADD COLUMN IF NOT EXISTS "is_reply" boolean DEFAULT false`);
  await sql.unsafe(`ALTER TABLE "interactions" ADD COLUMN IF NOT EXISTS "counterparty_email" text`);
  await sql.unsafe(`ALTER TABLE "interactions" ADD COLUMN IF NOT EXISTS "counterparty_name" text`);
  await sql.unsafe(`ALTER TABLE "interactions" ADD COLUMN IF NOT EXISTS "cold_prospect_id" uuid`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS "interactions_user_time_idx" ON "interactions" ("user_id","occurred_at")`);
  // Cold-outreach prospect store (separate from contacts; promoted on meeting set).
  await sql.unsafe(`DO $$ BEGIN
    CREATE TYPE "cold_status" AS ENUM ('messaged','replied','meeting_set','ghosted','promoted');
  EXCEPTION WHEN duplicate_object THEN null; END $$`);
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS "cold_prospects" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "name" text, "email" text, "linkedin_url" text, "linkedin_member_id" text, "company" text,
    "identity_key" text NOT NULL,
    "channel" "channel", "status" "cold_status" NOT NULL DEFAULT 'messaged',
    "first_outreach_at" timestamptz, "last_outbound_at" timestamptz, "last_inbound_at" timestamptz,
    "meeting_at" timestamptz,
    "promoted_contact_id" uuid REFERENCES "contacts"("id") ON DELETE SET NULL,
    "outbound_count" integer DEFAULT 0, "inbound_count" integer DEFAULT 0,
    "metadata" jsonb DEFAULT '{}'::jsonb,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  )`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS "cold_user_idx" ON "cold_prospects" ("user_id")`);
  await sql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "cold_identity_uq" ON "cold_prospects" ("user_id","identity_key")`);
  // Full calendar mirror + per-meeting held/notes outcome.
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS "calendar_events" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "source_ref" text NOT NULL,
    "source" text DEFAULT 'calendar',
    "title" text, "location" text,
    "start_at" timestamptz NOT NULL, "end_at" timestamptz,
    "all_day" boolean DEFAULT false,
    "attendees" jsonb DEFAULT '[]'::jsonb,
    "matched_contact_id" uuid REFERENCES "contacts"("id") ON DELETE SET NULL,
    "cold_prospect_id" uuid,
    "held" boolean, "held_confirmed_at" timestamptz, "notes" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  )`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS "cal_user_start_idx" ON "calendar_events" ("user_id","start_at")`);
  await sql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "cal_source_uq" ON "calendar_events" ("user_id","source_ref")`);
  // Manually blacklisted sender addresses (never tracked as conversations).
  await sql.unsafe(`ALTER TABLE "user_context" ADD COLUMN IF NOT EXISTS "blacklisted_emails" jsonb DEFAULT '[]'::jsonb`);
  // Per-situation voice guides learned from sent mail (reschedule, deal_share, catch_up, …).
  await sql.unsafe(`ALTER TABLE "user_context" ADD COLUMN IF NOT EXISTS "writing_style_by_situation" jsonb DEFAULT '{}'::jsonb`);
  // How a contact entered the rolodex (manual | meeting | csv | split | linkedin).
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "source" text`);
  // Rotation cursor for the news sweep so coverage cycles across the whole valuable pool.
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "last_news_check_at" timestamptz`);
  // One-time backfill: tag contacts that came from a met-with meeting or a promoted prospect.
  await sql.unsafe(`UPDATE "contacts" SET "source" = 'meeting' WHERE "source" IS NULL AND (
    "id" IN (SELECT "matched_contact_id" FROM "calendar_events" WHERE "matched_contact_id" IS NOT NULL)
    OR "id" IN (SELECT "promoted_contact_id" FROM "cold_prospects" WHERE "promoted_contact_id" IS NOT NULL)
  )`);
  // Raise professional/thesis-fit to 60% of relevance for anyone still on a lower baseline,
  // so an on-thesis investor ranks high on who they are, not just interaction history.
  await sql.unsafe(`UPDATE "user_context" SET "weights" = '{"professional":60,"recency":15,"relationship":10,"geographic":5,"trigger":0,"replyPropensity":10}'::jsonb
    WHERE "weights" IS NULL OR ("weights"->>'professional') IS NULL OR ("weights"->>'professional')::numeric < 60`);
  // Purge inferred "Meeting detected from conversation" events (source='llm') that polluted the
  // calendar. Detection is now disabled; this cleanup is idempotent (nothing new is created).
  await sql.unsafe(`DELETE FROM "calendar_events" WHERE "source" = 'llm'`);
  // Reconcile interactions logged as cold prospects that actually belong to a contact — match by
  // email first, then by exact full name. Fixes e.g. an email sent to an address not on the
  // contact's record. Idempotent: only touches rows with no contact yet.
  await sql.unsafe(`UPDATE "interactions" i SET "contact_id" = c."id", "cold_prospect_id" = NULL
    FROM "contacts" c
    WHERE i."contact_id" IS NULL AND i."counterparty_email" IS NOT NULL
      AND c."user_id" = i."user_id" AND lower(c."email") = lower(i."counterparty_email")`);
  await sql.unsafe(`UPDATE "interactions" i SET "contact_id" = c."id", "cold_prospect_id" = NULL
    FROM "contacts" c
    WHERE i."contact_id" IS NULL AND i."counterparty_name" IS NOT NULL
      AND c."user_id" = i."user_id" AND lower(c."name") = lower(trim(i."counterparty_name"))
      AND position(' ' in trim(i."counterparty_name")) > 0`);
  // Cached per-firm web research (global), fed into fit grading so niche on-thesis firms
  // (e.g. small VC / family offices) are graded on real intel, not the model's thin priors.
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS "firm_research" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "name_key" text NOT NULL UNIQUE,
    "name" text NOT NULL,
    "summary" text,
    "updated_at" timestamptz NOT NULL DEFAULT now()
  )`);
  // LinkedIn-vs-CRM reconciliation (auto-update audit + notes-stale flag).
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "field_updates" jsonb DEFAULT '[]'::jsonb`);
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "info_stale" boolean DEFAULT false`);
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "info_stale_reason" text`);
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "info_stale_at" timestamptz`);
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "company_stale" boolean DEFAULT false`);
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "email_stale" boolean DEFAULT false`);
  // Incremental fit-grading bookkeeping.
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "fit_graded_at" timestamptz`);
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "fit_graded_company" text`);
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "fit_graded_model" text`);
  // Per-contact Telegram outreach controls (block / dismiss / snooze).
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "outreach_blocked" boolean DEFAULT false`);
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "outreach_dismissed_at" timestamptz`);
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "outreach_snoozed_until" timestamptz`);
  // Manual fit/relevance override lock.
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "grades_locked" boolean DEFAULT false`);
  // Personal knowledge layer (alma maters, city, work anniversary, birthday, interests).
  await sql.unsafe(`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "personal_profile" jsonb`);
  // Dynamic, per-user relationship categories: relax the fixed enum to free text, and store each
  // user's own category set. Safe idempotent enum→text conversion (existing values preserved).
  await sql.unsafe(`ALTER TABLE "contacts" ALTER COLUMN "relationship" TYPE text USING "relationship"::text`);
  await sql.unsafe(`ALTER TABLE "user_context" ADD COLUMN IF NOT EXISTS "relationship_types" jsonb`);
  // Follow-up reminders captured from the Telegram chat.
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS "reminders" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id" uuid NOT NULL,
    "contact_id" uuid,
    "contact_name" text,
    "note" text NOT NULL,
    "due_at" timestamptz NOT NULL,
    "status" text DEFAULT 'pending',
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "sent_at" timestamptz
  )`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS "reminders_status_due_idx" ON "reminders" ("status","due_at")`);
  // New trigger types: personal touches + the follow-through / going-cold engine.
  for (const v of ["work_anniversary", "birthday", "personal_event", "reply", "follow_up", "going_cold"]) {
    await sql.unsafe(`ALTER TYPE "trigger_type" ADD VALUE IF NOT EXISTS '${v}'`);
  }
  console.log("[db] ensureSchema applied.");
}
