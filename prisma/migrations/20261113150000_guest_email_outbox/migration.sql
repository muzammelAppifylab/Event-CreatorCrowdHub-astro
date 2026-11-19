-- Guest email outbox (audit H-3, M-21): guest emails are rows drained by the `guest-email-outbox`
-- job in bounded batches, instead of one platform job each (the platform adds ~10 jobs a minute).
-- Reminder deliveries count their tries (audit M-19): retries back off and stop at a cap.
BEGIN;

CREATE TABLE "guest_email_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "idempotency_key" VARCHAR(200) NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "rsvp_id" UUID,
    "invite_id" UUID,
    "message_id" UUID,
    "status" VARCHAR(12) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" VARCHAR(500),
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "guest_email_outbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "guest_email_outbox_status_check" CHECK ("status" IN ('pending', 'sent', 'skipped', 'failed')),
    CONSTRAINT "guest_email_outbox_attempts_nonneg" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "guest_email_outbox_key_uq" ON "guest_email_outbox"("idempotency_key");
CREATE INDEX "guest_email_outbox_due_idx" ON "guest_email_outbox"("next_attempt_at") WHERE ((status)::text = 'pending'::text);
CREATE INDEX "guest_email_outbox_kind_created_idx" ON "guest_email_outbox"("kind", "created_at");
CREATE INDEX "guest_email_outbox_created_idx" ON "guest_email_outbox"("created_at");

ALTER TABLE "message_deliveries" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

COMMIT;
