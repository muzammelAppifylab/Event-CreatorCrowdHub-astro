-- Public-route abuse limits move from per-isolate memory to the database (RSVP submit/edit, the
-- "lost my link" form, guest emails a public route triggers, page-view beacons). One row per counted
-- attempt, keyed by a keyed hash of the IP / email / event (never the raw value). Checked with one
-- conditional INSERT ... SELECT per request over bounded counts; rows older than a day are swept in
-- bounded batches by src/server/rate-attempts.ts.
--
-- event_settings.pending_logo_file_id: the logo upload step 1 issued; step 3 accepts (and may delete)
-- only that id, never a file id the client names.
BEGIN;

CREATE TABLE "rate_attempts" (
    "id" BIGSERIAL NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "key_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rate_attempts_kind_key_created_idx" ON "rate_attempts"("kind", "key_hash", "created_at");
CREATE INDEX "rate_attempts_created_idx" ON "rate_attempts"("created_at");

ALTER TABLE "event_settings" ADD COLUMN "pending_logo_file_id" VARCHAR(40);

COMMIT;
