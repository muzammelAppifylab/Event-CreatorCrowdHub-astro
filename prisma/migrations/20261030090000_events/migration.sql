-- Events: ported from CreatorCrowdHub. One transaction: all or nothing.
BEGIN;

-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('queued', 'sent', 'failed');
-- CreateEnum
CREATE TYPE "event_format" AS ENUM ('in_person', 'online', 'hybrid');
-- CreateEnum
CREATE TYPE "event_status" AS ENUM ('draft', 'published', 'cancelled');
-- CreateEnum
CREATE TYPE "event_visibility" AS ENUM ('public', 'unlisted', 'private');
-- CreateEnum
CREATE TYPE "font_preset" AS ENUM ('inter', 'serif', 'rounded');
-- CreateEnum
CREATE TYPE "invite_status" AS ENUM ('queued', 'sent', 'bounced', 'responded');
-- CreateEnum
CREATE TYPE "poll_status" AS ENUM ('draft', 'open', 'closed');
-- CreateEnum
CREATE TYPE "poll_type" AS ENUM ('single_choice', 'multi_choice', 'rating', 'short_text');
-- CreateEnum
CREATE TYPE "question_type" AS ENUM ('short_text', 'long_text', 'single_choice', 'multi_choice', 'checkbox');
-- CreateEnum
CREATE TYPE "reminder_kind" AS ENUM ('confirmation', 'reminder', 'live_now', 'thank_you');
-- CreateEnum
CREATE TYPE "rsvp_response" AS ENUM ('going', 'maybe', 'not_going');
-- CreateEnum
CREATE TYPE "rsvp_source" AS ENUM ('direct', 'invite', 'host_page');
-- CreateEnum
CREATE TYPE "rsvp_status" AS ENUM ('pending', 'confirmed', 'waitlisted', 'declined', 'cancelled', 'awaiting_payment');
-- CreateEnum
CREATE TYPE "segment" AS ENUM ('going', 'maybe', 'waitlisted', 'pending', 'checked_in', 'no_show', 'all');
-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "cover_image_url" TEXT,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "timezone" TEXT NOT NULL,
    "format" "event_format" NOT NULL,
    "venue_name" TEXT,
    "venue_address" TEXT,
    "map_url" TEXT,
    "join_url" TEXT,
    "visibility" "event_visibility" NOT NULL DEFAULT 'public',
    "status" "event_status" NOT NULL DEFAULT 'draft',
    "capacity" INTEGER,
    "rsvp_deadline" TIMESTAMPTZ(6),
    "waitlist_enabled" BOOLEAN NOT NULL DEFAULT true,
    "approval_required" BOOLEAN NOT NULL DEFAULT false,
    "allow_maybe" BOOLEAN NOT NULL DEFAULT true,
    "max_plus_ones" SMALLINT NOT NULL DEFAULT 0,
    "show_guest_list" BOOLEAN NOT NULL DEFAULT false,
    "poll_join_code" VARCHAR(6) NOT NULL,
    "thank_you_link" TEXT,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cover_poster" TEXT,
    "cover_style" JSONB,
    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "invites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "token" TEXT NOT NULL,
    "status" "invite_status" NOT NULL DEFAULT 'queued',
    "sent_at" TIMESTAMPTZ(6),
    "last_resent_at" TIMESTAMPTZ(6),
    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "message_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "rsvp_id" UUID,
    "invite_id" UUID,
    "reminder_rule_id" UUID,
    "message_id" UUID,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "status" "delivery_status" NOT NULL DEFAULT 'queued',
    "sent_at" TIMESTAMPTZ(6),
    "error" TEXT,
    CONSTRAINT "message_deliveries_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "segment" "segment" NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "sent_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotency_key" TEXT,
    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "page_views" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "visitor_hash" TEXT NOT NULL,
    "utm_source" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "day" DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'utc'::text))::date,
    CONSTRAINT "page_views_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "poll_options" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "poll_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    CONSTRAINT "poll_options_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "poll_votes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "poll_id" UUID NOT NULL,
    "voter_token" UUID NOT NULL,
    "rsvp_id" UUID,
    "option_ids" JSONB NOT NULL DEFAULT '[]',
    "rating_value" SMALLINT,
    "text_value" VARCHAR(140),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "poll_votes_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "polls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "type" "poll_type" NOT NULL,
    "status" "poll_status" NOT NULL DEFAULT 'draft',
    "anonymous" BOOLEAN NOT NULL DEFAULT true,
    "show_results_to_voters" BOOLEAN NOT NULL DEFAULT true,
    "opened_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    CONSTRAINT "polls_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "reminder_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "kind" "reminder_kind" NOT NULL,
    "offset_minutes" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    CONSTRAINT "reminder_rules_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "rsvp_answers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "rsvp_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "value" JSONB NOT NULL,
    CONSTRAINT "rsvp_answers_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "rsvp_questions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "type" "question_type" NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "required" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "rsvp_questions_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "rsvps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "ticket_type_id" UUID,
    "invite_id" UUID,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "response" "rsvp_response" NOT NULL,
    "status" "rsvp_status" NOT NULL,
    "plus_ones" SMALLINT NOT NULL DEFAULT 0,
    "seats" SMALLINT NOT NULL DEFAULT 1,
    "ticket_code" VARCHAR(8) NOT NULL,
    "manage_token" TEXT NOT NULL,
    "marketing_consent" BOOLEAN NOT NULL DEFAULT false,
    "checked_in_at" TIMESTAMPTZ(6),
    "attended" BOOLEAN,
    "waitlist_position" INTEGER,
    "claim_expires_at" TIMESTAMPTZ(6),
    "source" "rsvp_source" NOT NULL DEFAULT 'direct',
    "utm_source" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(6),
    "consent_confirmed_at" TIMESTAMPTZ(6),
    CONSTRAINT "rsvps_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "ticket_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "quantity" INTEGER,
    "sales_end_at" TIMESTAMPTZ(6),
    CONSTRAINT "ticket_types_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "event_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "brand_color" VARCHAR(7),
    "font_preset" "font_preset" NOT NULL DEFAULT 'inter',
    "default_timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "sender_name" VARCHAR(80) NOT NULL DEFAULT '',
    "reply_to_email" VARCHAR(254) NOT NULL DEFAULT '',
    "default_reminder_rules" JSONB NOT NULL DEFAULT '[]',
    "allow_maybe_default" BOOLEAN NOT NULL DEFAULT true,
    "show_guest_list_default" BOOLEAN NOT NULL DEFAULT false,
    "default_cover_poster" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "event_settings_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "ticket_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "rsvp_id" UUID NOT NULL,
    "checkout_id" VARCHAR(80) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "seats" SMALLINT NOT NULL DEFAULT 1,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_orders_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "events_slug_live_uq" ON "events"("slug") WHERE (deleted_at IS NULL);
-- CreateIndex
CREATE UNIQUE INDEX "events_poll_join_code_uq" ON "events"("poll_join_code");
-- CreateIndex
CREATE INDEX "events_published_start_idx" ON "events"("start_at") WHERE ((status = 'published'::event_status) AND (deleted_at IS NULL));
-- CreateIndex
CREATE UNIQUE INDEX "invites_token_uq" ON "invites"("token");
-- CreateIndex
CREATE UNIQUE INDEX "invites_event_email_uq" ON "invites"("event_id", "email");
-- CreateIndex
CREATE INDEX "message_deliveries_invite_idx" ON "message_deliveries"("invite_id");
-- CreateIndex
CREATE INDEX "message_deliveries_message_idx" ON "message_deliveries"("message_id");
-- CreateIndex
CREATE INDEX "message_deliveries_rule_idx" ON "message_deliveries"("reminder_rule_id");
-- CreateIndex
CREATE INDEX "message_deliveries_status_idx" ON "message_deliveries"("status");
-- CreateIndex
CREATE UNIQUE INDEX "message_deliveries_rsvp_rule_uq" ON "message_deliveries"("rsvp_id", "reminder_rule_id");
-- CreateIndex
CREATE INDEX "messages_event_idx" ON "messages"("event_id");
-- CreateIndex
CREATE INDEX "messages_sent_by_idx" ON "messages"("sent_by");
-- CreateIndex
CREATE UNIQUE INDEX "messages_event_idempotency_uq" ON "messages"("event_id", "idempotency_key");
-- CreateIndex
CREATE INDEX "page_views_event_created_idx" ON "page_views"("event_id", "created_at");
-- CreateIndex
CREATE UNIQUE INDEX "page_views_event_visitor_day_uq" ON "page_views"("event_id", "visitor_hash", "day");
-- CreateIndex
CREATE INDEX "poll_options_poll_idx" ON "poll_options"("poll_id");
-- CreateIndex
CREATE INDEX "poll_votes_rsvp_idx" ON "poll_votes"("rsvp_id");
-- CreateIndex
CREATE UNIQUE INDEX "poll_votes_poll_voter_uq" ON "poll_votes"("poll_id", "voter_token");
-- CreateIndex
CREATE UNIQUE INDEX "polls_one_open_per_event_uq" ON "polls"("event_id") WHERE (status = 'open'::poll_status);
-- CreateIndex
CREATE INDEX "reminder_rules_event_idx" ON "reminder_rules"("event_id");
-- CreateIndex
CREATE INDEX "rsvp_answers_question_idx" ON "rsvp_answers"("question_id");
-- CreateIndex
CREATE UNIQUE INDEX "rsvp_answers_rsvp_question_uq" ON "rsvp_answers"("rsvp_id", "question_id");
-- CreateIndex
CREATE INDEX "rsvp_questions_event_idx" ON "rsvp_questions"("event_id");
-- CreateIndex
CREATE UNIQUE INDEX "rsvps_ticket_code_uq" ON "rsvps"("ticket_code");
-- CreateIndex
CREATE UNIQUE INDEX "rsvps_manage_token_uq" ON "rsvps"("manage_token");
-- CreateIndex
CREATE INDEX "rsvps_awaiting_payment_idx" ON "rsvps"("updated_at") WHERE (status = 'awaiting_payment'::rsvp_status);
-- CreateIndex
CREATE INDEX "rsvps_event_status_idx" ON "rsvps"("event_id", "status");
-- CreateIndex
CREATE INDEX "rsvps_invite_idx" ON "rsvps"("invite_id");
-- CreateIndex
CREATE INDEX "rsvps_ticket_type_idx" ON "rsvps"("ticket_type_id");
-- CreateIndex
CREATE INDEX "rsvps_waitlist_claim_idx" ON "rsvps"("claim_expires_at") WHERE ((status = 'waitlisted'::rsvp_status) AND (claim_expires_at IS NOT NULL));
-- CreateIndex
CREATE UNIQUE INDEX "rsvps_event_email_uq" ON "rsvps"("event_id", "email");
-- CreateIndex
CREATE INDEX "ticket_types_event_idx" ON "ticket_types"("event_id");
-- CreateIndex
CREATE UNIQUE INDEX "ticket_orders_checkout_id_key" ON "ticket_orders"("checkout_id");
-- CreateIndex
CREATE INDEX "ticket_orders_rsvp_id_idx" ON "ticket_orders"("rsvp_id");
-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "invites"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_reminder_rule_id_reminder_rules_id_fk" FOREIGN KEY ("reminder_rule_id") REFERENCES "reminder_rules"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_rsvp_id_rsvps_id_fk" FOREIGN KEY ("rsvp_id") REFERENCES "rsvps"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "page_views" ADD CONSTRAINT "page_views_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "polls"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "polls"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_rsvp_id_rsvps_id_fk" FOREIGN KEY ("rsvp_id") REFERENCES "rsvps"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "polls" ADD CONSTRAINT "polls_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "reminder_rules" ADD CONSTRAINT "reminder_rules_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "rsvp_answers" ADD CONSTRAINT "rsvp_answers_question_id_rsvp_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "rsvp_questions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "rsvp_answers" ADD CONSTRAINT "rsvp_answers_rsvp_id_rsvps_id_fk" FOREIGN KEY ("rsvp_id") REFERENCES "rsvps"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "rsvp_questions" ADD CONSTRAINT "rsvp_questions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "rsvps" ADD CONSTRAINT "rsvps_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "rsvps" ADD CONSTRAINT "rsvps_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "invites"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "rsvps" ADD CONSTRAINT "rsvps_ticket_type_id_ticket_types_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "ticket_types"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "ticket_orders" ADD CONSTRAINT "ticket_orders_rsvp_id_fkey" FOREIGN KEY ("rsvp_id") REFERENCES "rsvps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Rules Prisma cannot express (CHECK constraints from the source app).
ALTER TABLE "events" ADD CONSTRAINT "events_end_after_start" CHECK ("end_at" > "start_at");
ALTER TABLE "events" ADD CONSTRAINT "events_capacity_positive" CHECK ("capacity" IS NULL OR "capacity" > 0);
ALTER TABLE "events" ADD CONSTRAINT "events_plus_ones_range" CHECK ("max_plus_ones" BETWEEN 0 AND 5);
ALTER TABLE "events" ADD CONSTRAINT "events_cover_poster_valid" CHECK ("cover_poster" IS NULL OR "cover_poster" IN ('breakfast', 'launch', 'ama', 'mastermind', 'workshop', 'kickoff'));
ALTER TABLE "events" ADD CONSTRAINT "events_cover_image_url_http" CHECK ("cover_image_url" IS NULL OR "cover_image_url" = '' OR "cover_image_url" ~* '^https?://');
ALTER TABLE "events" ADD CONSTRAINT "events_map_url_http" CHECK ("map_url" IS NULL OR "map_url" = '' OR "map_url" ~* '^https?://');
ALTER TABLE "events" ADD CONSTRAINT "events_join_url_http" CHECK ("join_url" IS NULL OR "join_url" = '' OR "join_url" ~* '^https?://');
ALTER TABLE "events" ADD CONSTRAINT "events_thank_you_link_http" CHECK ("thank_you_link" IS NULL OR "thank_you_link" = '' OR "thank_you_link" ~* '^https?://');
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_rating_range" CHECK ("rating_value" IS NULL OR "rating_value" BETWEEN 1 AND 5);
ALTER TABLE "rsvps" ADD CONSTRAINT "rsvps_seats_match" CHECK ("seats" = 1 + "plus_ones");
ALTER TABLE "rsvps" ADD CONSTRAINT "rsvps_email_lower" CHECK ("email" = lower("email"));
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_price_nonneg" CHECK ("price_cents" >= 0);
ALTER TABLE "event_settings" ADD CONSTRAINT "event_settings_singleton" CHECK ("id" = 1);
ALTER TABLE "event_settings" ADD CONSTRAINT "event_settings_default_cover_poster_valid" CHECK ("default_cover_poster" IS NULL OR "default_cover_poster" IN ('breakfast', 'launch', 'ama', 'mastermind', 'workshop', 'kickoff'));
INSERT INTO "event_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;

COMMIT;
