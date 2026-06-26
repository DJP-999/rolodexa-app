import { pgTable, pgEnum, uuid, text, timestamp, boolean, integer, real, jsonb, date, index, uniqueIndex, vector } from "drizzle-orm/pg-core";
export const relationshipCategory = pgEnum("relationship_category", ["family","friend","coworker","investor","vendor","other"]);
export const contactStatus = pgEnum("contact_status", ["active","warming","going_cold","dormant"]);
export const triggerType = pgEnum("trigger_type", ["re_engage","job_change","milestone"]);
export const suggestionStatus = pgEnum("suggestion_status", ["pending","approved","snoozed","dismissed","sent"]);
export const priority = pgEnum("priority", ["high","medium","low"]);
export const interactionType = pgEnum("interaction_type", ["email_in","email_out","meeting","message_in","message_out"]);
export const channel = pgEnum("channel", ["nylas_email","nylas_calendar","telegram","imessage","agent_audit","linkedin"]);
export const notificationOutcome = pgEnum("notification_outcome", ["sent","opened","clicked","approved","snoozed","dismissed","ignored"]);
export const coldStatus = pgEnum("cold_status", ["messaged","replied","meeting_set","ghosted","promoted"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const userContext = pgTable("user_context", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  role: text("role"), currentFocus: text("current_focus"), priorityConnections: text("priority_connections"),
  activeProjects: text("active_projects"), painPoints: jsonb("pain_points").$type<string[]>().default([]),
  timezone: text("timezone").default("America/New_York"), writingStyle: text("writing_style"), firstEnrichDone: boolean("first_enrich_done").default(false),
  writingStyleSource: text("writing_style_source").default("auto"), writingStyleSamples: integer("writing_style_samples").default(0),
  writingStyleUpdatedAt: timestamp("writing_style_updated_at", { withTimezone: true }),
  // Per-situation voice guides (reschedule, deal_share, catch_up, …) learned from sent mail.
  writingStyleBySituation: jsonb("writing_style_by_situation").$type<Record<string, string>>().default({}),
  fieldGroupings: jsonb("field_groupings").$type<Record<string, { label: string; categories: string[]; multi?: boolean }>>().default({}),
  weights: jsonb("weights").$type<{professional:number;recency:number;relationship:number;geographic:number;trigger:number;replyPropensity:number}>().default({professional:60,recency:15,relationship:10,geographic:5,trigger:0,replyPropensity:10}),
  blacklistedEmails: jsonb("blacklisted_emails").$type<string[]>().default([]),
  observationUntil: date("observation_until"),
  maxNudgesPerDay: integer("max_nudges_per_day").default(3),
  gateConfidence: real("gate_confidence").default(0.6),
  gateReplyPropensity: real("gate_reply_propensity").default(0.4),
  gateProjectMatch: real("gate_project_match").default(0.55),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  canonicalId: uuid("canonical_id"), isOrganization: boolean("is_organization").default(false),
  isVerifiedPerson: boolean("is_verified_person").default(false),
  name: text("name").notNull(), correctedName: text("corrected_name"), email: text("email"),
  company: text("company"), role: text("role"), location: text("location"), linkedinUrl: text("linkedin_url"),
  industry: text("industry"), alternateNames: jsonb("alternate_names").$type<string[]>().default([]),
  otherSignals: jsonb("other_signals").$type<string[]>().default([]),
  xHandle: text("x_handle"), xUserId: text("x_user_id"), xCheckedAt: timestamp("x_checked_at", { withTimezone: true }),
  linkedinMemberId: text("linkedin_member_id"),
  customFields: jsonb("custom_fields").$type<Record<string, string>>().default({}),
  normalizedFields: jsonb("normalized_fields").$type<Record<string, string>>().default({}),
  relationship: relationshipCategory("relationship").default("other"),
  relevance: integer("relevance"), replyPropensity: real("reply_propensity"),
  rpFeatures: jsonb("rp_features").$type<Record<string, number>>(), rpVersion: integer("rp_version").default(1),
  status: contactStatus("status").default("active"), highValue: boolean("high_value").default(false),
  importPriority: real("import_priority"), lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
  enrichedAt: timestamp("enriched_at", { withTimezone: true }), gradedAt: timestamp("graded_at", { withTimezone: true }),
  lastNewsCheckAt: timestamp("last_news_check_at", { withTimezone: true }),
  gradeRationale: text("grade_rationale"), summary: text("summary"), professionalFit: real("professional_fit"), profileData: jsonb("profile_data").$type<Record<string, unknown>>(), embedding: vector("embedding", { dimensions: 1536 }),
  // Firm intel matched from the user's imported PitchBook reference data (kept separate
  // from the user's own customFields/normalizedFields — never overwrites their data).
  pitchbookData: jsonb("pitchbook_data").$type<Record<string, string>>(),
  // How this contact entered the rolodex: manual | meeting | csv | split | linkedin.
  source: text("source"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ userIdx: index("contacts_user_idx").on(t.userId), emailIdx: index("contacts_email_idx").on(t.userId, t.email), relevanceIdx: index("contacts_relevance_idx").on(t.userId, t.relevance) }));
// PitchBook export reference data — FIRMS/investors. Deliberately a SEPARATE table from
// contacts so the user's real, met-with rolodex never mixes with PitchBook records.
export const pitchbookFirms = pgTable("pitchbook_firms", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  nameKey: text("name_key").notNull(), // normalized firm name for matching to contacts
  customFields: jsonb("custom_fields").$type<Record<string, string>>().default({}),
  normalizedFields: jsonb("normalized_fields").$type<Record<string, string>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ pbUserIdx: index("pb_firms_user_idx").on(t.userId), pbKeyIdx: index("pb_firms_key_idx").on(t.userId, t.nameKey) }));
export const claims = pgTable("claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }).notNull(),
  field: text("field").notNull(), value: text("value").notNull(), sourceUrl: text("source_url"),
  eventDate: date("event_date"), publishedDate: date("published_date"), confidence: real("confidence"),
  observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ contactIdx: index("claims_contact_idx").on(t.contactId), eventIdx: index("claims_event_idx").on(t.contactId, t.eventDate) }));
export const interactions = pgTable("interactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  eventType: interactionType("event_type").notNull(), direction: text("direction"), channel: channel("channel").notNull(),
  threadId: text("thread_id"), occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  sourceRef: text("source_ref"), metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  // Reply = inbound message on a thread where the user previously sent outbound.
  isReply: boolean("is_reply").default(false),
  // Counterparty identity even when no contact is matched (cold outreach / unknown sender).
  counterpartyEmail: text("counterparty_email"), counterpartyName: text("counterparty_name"),
  coldProspectId: uuid("cold_prospect_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ contactTime: index("interactions_contact_time_idx").on(t.contactId, t.occurredAt), userTime: index("interactions_user_time_idx").on(t.userId, t.occurredAt), idempotent: uniqueIndex("interactions_source_uq").on(t.userId, t.channel, t.sourceRef) }));
// Cold-outreach prospects: people you've reached out to who are NOT (yet) in your rolodex.
// Kept in their own table; auto-promoted into contacts when a meeting is set.
export const coldProspects = pgTable("cold_prospects", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  name: text("name"), email: text("email"), linkedinUrl: text("linkedin_url"),
  linkedinMemberId: text("linkedin_member_id"), company: text("company"),
  identityKey: text("identity_key").notNull(), // normalized email or li member id, for dedup
  channel: channel("channel"), status: coldStatus("status").default("messaged").notNull(),
  firstOutreachAt: timestamp("first_outreach_at", { withTimezone: true }),
  lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
  lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
  meetingAt: timestamp("meeting_at", { withTimezone: true }),
  promotedContactId: uuid("promoted_contact_id").references(() => contacts.id, { onDelete: "set null" }),
  outboundCount: integer("outbound_count").default(0), inboundCount: integer("inbound_count").default(0),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ cpUserIdx: index("cold_user_idx").on(t.userId), cpKeyUq: uniqueIndex("cold_identity_uq").on(t.userId, t.identityKey) }));
export const suggestions = pgTable("suggestions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
  triggerType: triggerType("trigger_type").notNull(), reason: text("reason").notNull(),
  draftMessage: text("draft_message"), rationale: text("rationale"), intentLabel: text("intent_label"), priority: priority("priority").default("medium"),
  score: real("score"), status: suggestionStatus("status").default("pending"),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  claimIds: jsonb("claim_ids").$type<string[]>().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ userStatus: index("suggestions_user_status_idx").on(t.userId, t.status) }));
export const notificationEvents = pgTable("notification_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  suggestionId: uuid("suggestion_id").references(() => suggestions.id, { onDelete: "set null" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  triggerType: triggerType("trigger_type"), category: text("category"), channel: channel("channel"),
  sentAt: timestamp("sent_at", { withTimezone: true }), outcome: notificationOutcome("outcome").default("sent"),
  outcomeAt: timestamp("outcome_at", { withTimezone: true }), metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
}, (t) => ({ userTime: index("notif_user_time_idx").on(t.userId, t.sentAt) }));
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(), oneLiner: text("one_liner"), memoryDoc: text("memory_doc"),
  embedding: vector("embedding", { dimensions: 1536 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export const automations = pgTable("automations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  slug: text("slug").notNull(), name: text("name").notNull(), description: text("description"),
  cron: text("cron").notNull(), timezone: text("timezone").default("America/New_York"), prompt: text("prompt").notNull(),
  enabled: boolean("enabled").default(true), lastRunAt: timestamp("last_run_at", { withTimezone: true }), lastRunStatus: text("last_run_status"),
});
export const connectedAccounts = pgTable("connected_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  provider: text("provider").notNull(), externalId: text("external_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const messageLog = pgTable("message_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  direction: text("direction").notNull(), channel: channel("channel").notNull(), text: text("text"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const jobRuns = pgTable("job_runs", {
  id: uuid("id").primaryKey().defaultRandom(), name: text("name").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }), status: text("status").default("running"),
  detail: jsonb("detail").$type<Record<string, unknown>>().default({}),
});

// Every event on the user's connected calendar (full Google-Calendar mirror). Meetings
// with people in the network/cold list are matched + carry a held/notes outcome.
export const calendarEvents = pgTable("calendar_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  sourceRef: text("source_ref").notNull(), // provider event id (or llm-... for inferred)
  source: text("source").default("calendar"), // calendar | llm
  title: text("title"), location: text("location"),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true }),
  allDay: boolean("all_day").default(false),
  attendees: jsonb("attendees").$type<{ email: string; name: string | null }[]>().default([]),
  matchedContactId: uuid("matched_contact_id").references(() => contacts.id, { onDelete: "set null" }),
  coldProspectId: uuid("cold_prospect_id"),
  held: boolean("held"), // null = pending confirmation, true = held, false = no-show
  heldConfirmedAt: timestamp("held_confirmed_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ ceUserStart: index("cal_user_start_idx").on(t.userId, t.startAt), ceSourceUq: uniqueIndex("cal_source_uq").on(t.userId, t.sourceRef) }));

export type Contact = typeof contacts.$inferSelect;
export type Claim = typeof claims.$inferSelect;
export type Interaction = typeof interactions.$inferSelect;
export type ColdProspect = typeof coldProspects.$inferSelect;
export type CalendarEvent = typeof calendarEvents.$inferSelect;
