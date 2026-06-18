CREATE TYPE "public"."channel" AS ENUM('nylas_email', 'nylas_calendar', 'telegram', 'imessage', 'agent_audit');--> statement-breakpoint
CREATE TYPE "public"."contact_status" AS ENUM('active', 'warming', 'going_cold', 'dormant');--> statement-breakpoint
CREATE TYPE "public"."interaction_type" AS ENUM('email_in', 'email_out', 'meeting', 'message_in', 'message_out');--> statement-breakpoint
CREATE TYPE "public"."notification_outcome" AS ENUM('sent', 'opened', 'clicked', 'approved', 'snoozed', 'dismissed', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."relationship_category" AS ENUM('family', 'friend', 'coworker', 'investor', 'vendor', 'other');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('pending', 'approved', 'snoozed', 'dismissed', 'sent');--> statement-breakpoint
CREATE TYPE "public"."trigger_type" AS ENUM('re_engage', 'job_change', 'milestone');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'America/New_York',
	"prompt" text NOT NULL,
	"enabled" boolean DEFAULT true,
	"last_run_at" timestamp with time zone,
	"last_run_status" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"field" text NOT NULL,
	"value" text NOT NULL,
	"source_url" text,
	"event_date" date,
	"published_date" date,
	"confidence" real,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connected_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"canonical_id" uuid,
	"is_organization" boolean DEFAULT false,
	"is_verified_person" boolean DEFAULT false,
	"name" text NOT NULL,
	"corrected_name" text,
	"email" text,
	"company" text,
	"role" text,
	"location" text,
	"linkedin_url" text,
	"industry" text,
	"alternate_names" jsonb DEFAULT '[]'::jsonb,
	"other_signals" jsonb DEFAULT '[]'::jsonb,
	"relationship" "relationship_category" DEFAULT 'other',
	"relevance" integer,
	"reply_propensity" real,
	"rp_features" jsonb,
	"rp_version" integer DEFAULT 1,
	"status" "contact_status" DEFAULT 'active',
	"high_value" boolean DEFAULT false,
	"import_priority" real,
	"last_contacted_at" timestamp with time zone,
	"enriched_at" timestamp with time zone,
	"graded_at" timestamp with time zone,
	"grade_rationale" text,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"contact_id" uuid,
	"event_type" "interaction_type" NOT NULL,
	"direction" text,
	"channel" "channel" NOT NULL,
	"thread_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"source_ref" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running',
	"detail" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"channel" "channel" NOT NULL,
	"text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"suggestion_id" uuid,
	"contact_id" uuid,
	"trigger_type" "trigger_type",
	"category" text,
	"channel" "channel",
	"sent_at" timestamp with time zone,
	"outcome" "notification_outcome" DEFAULT 'sent',
	"outcome_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"one_liner" text,
	"memory_doc" text,
	"embedding" vector(1536),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"contact_id" uuid,
	"trigger_type" "trigger_type" NOT NULL,
	"reason" text NOT NULL,
	"draft_message" text,
	"intent_label" text,
	"priority" "priority" DEFAULT 'medium',
	"score" real,
	"status" "suggestion_status" DEFAULT 'pending',
	"claim_ids" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_context" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"role" text,
	"current_focus" text,
	"priority_connections" text,
	"active_projects" text,
	"pain_points" jsonb DEFAULT '[]'::jsonb,
	"timezone" text DEFAULT 'America/New_York',
	"weights" jsonb DEFAULT '{"professional":30,"recency":25,"relationship":20,"geographic":15,"trigger":10,"replyPropensity":0}'::jsonb,
	"observation_until" date,
	"max_nudges_per_day" integer DEFAULT 3,
	"gate_confidence" real DEFAULT 0.6,
	"gate_reply_propensity" real DEFAULT 0.4,
	"gate_project_match" real DEFAULT 0.55,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automations" ADD CONSTRAINT "automations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claims" ADD CONSTRAINT "claims_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "interactions" ADD CONSTRAINT "interactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "interactions" ADD CONSTRAINT "interactions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_log" ADD CONSTRAINT "message_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_suggestion_id_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_context" ADD CONSTRAINT "user_context_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claims_contact_idx" ON "claims" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claims_event_idx" ON "claims" USING btree ("contact_id","event_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_user_idx" ON "contacts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_email_idx" ON "contacts" USING btree ("user_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_relevance_idx" ON "contacts" USING btree ("user_id","relevance");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "interactions_contact_time_idx" ON "interactions" USING btree ("contact_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "interactions_source_uq" ON "interactions" USING btree ("user_id","channel","source_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notif_user_time_idx" ON "notification_events" USING btree ("user_id","sent_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suggestions_user_status_idx" ON "suggestions" USING btree ("user_id","status");