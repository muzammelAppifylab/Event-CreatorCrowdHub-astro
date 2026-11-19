-- Page-view visitor hashes (audit L-43): a RANDOM salt per UTC day instead of one derived from a
-- fixed secret, so a hash cannot be recomputed from an IP once the day's salt is gone. One row per
-- day, created on first use (ON CONFLICT DO NOTHING); rows older than 2 days are deleted by
-- src/server/routes/pageviews.ts when the next day's salt is created.
BEGIN;

CREATE TABLE "page_view_salts" (
    "day" DATE NOT NULL,
    "salt" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_view_salts_pkey" PRIMARY KEY ("day")
);

COMMIT;
