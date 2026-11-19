-- Guest privacy (audit M-25, M-26, M-27). Wrapped in one transaction: if any statement fails,
-- none of them apply and the live site keeps its old schema (docs/agent/database.md).
BEGIN;

-- When this person unsubscribed from the host's updates: set on every RSVP with the address,
-- honoured by host broadcasts and the contacts list. Nullable, no default: a metadata-only change.
ALTER TABLE "rsvps" ADD COLUMN "unsubscribed_at" TIMESTAMPTZ(6);

-- The erasure log: hashed address + event, so erasures survive a backup restore. No foreign keys
-- on purpose (it must outlive the event and the RSVP).
CREATE TABLE "guest_erasures" (
    "email_hash" CHAR(64) NOT NULL,
    "event_id" UUID NOT NULL,
    "erased_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_erasures_pkey" PRIMARY KEY ("email_hash", "event_id")
);

CREATE INDEX "guest_erasures_event_idx" ON "guest_erasures"("event_id");

-- Rate limit for the public privacy links (audit L-40): one row per request, keyed HMACs of the
-- client IP and of the link token (never the raw values). Pruned daily by the retention job.
CREATE TABLE "privacy_attempts" (
    "id" BIGSERIAL NOT NULL,
    "ip_hash" CHAR(64) NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "privacy_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "privacy_attempts_ip_created_idx" ON "privacy_attempts"("ip_hash", "created_at");
CREATE INDEX "privacy_attempts_token_created_idx" ON "privacy_attempts"("token_hash", "created_at");
CREATE INDEX "privacy_attempts_created_idx" ON "privacy_attempts"("created_at");

COMMIT;
