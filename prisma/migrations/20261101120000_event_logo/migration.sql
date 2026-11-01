-- The creator's own logo (a public platform file) on the event settings row.
BEGIN;

ALTER TABLE "event_settings" ADD COLUMN "logo_file_id" VARCHAR(40);
ALTER TABLE "event_settings" ADD COLUMN "logo_name" VARCHAR(200);

COMMIT;
