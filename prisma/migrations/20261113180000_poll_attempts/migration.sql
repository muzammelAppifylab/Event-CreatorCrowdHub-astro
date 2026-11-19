-- Live-poll abuse limits on the site's own table (audit M-3, L-9, L-40): one row per vote and per
-- missed join-code lookup, keyed by keyed hashes of the IP and the voter device (never raw values).
-- Checked with bounded counts (LIMIT N+1) and never under a lock, so a room on one Wi-Fi can vote at
-- once. Rows older than a day are swept in bounded batches by src/server/routes/polls-public.ts.
BEGIN;

CREATE TABLE "poll_attempts" (
    "id" BIGSERIAL NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "ip_hash" CHAR(64) NOT NULL,
    "device_hash" CHAR(64),
    "new_device" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "poll_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "poll_attempts_kind_ip_created_idx" ON "poll_attempts"("kind", "ip_hash", "created_at");
CREATE INDEX "poll_attempts_device_created_idx" ON "poll_attempts"("device_hash", "created_at");
CREATE INDEX "poll_attempts_created_idx" ON "poll_attempts"("created_at");

-- The streamed vote CSV walks one poll oldest first, keyset (created_at, id) (audit M-22).
CREATE INDEX "poll_votes_poll_created_idx" ON "poll_votes"("poll_id", "created_at", "id");

COMMIT;
