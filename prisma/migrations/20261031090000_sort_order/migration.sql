-- Organiser-controlled ordering for ticket types, RSVP questions, polls and poll options.
BEGIN;

ALTER TABLE "ticket_types" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "rsvp_questions" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "polls" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "poll_options" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;

UPDATE "ticket_types" t SET "sort_order" = r.n FROM (
  SELECT id, (row_number() OVER (PARTITION BY event_id ORDER BY id) - 1)::int AS n FROM "ticket_types") r WHERE t.id = r.id;
UPDATE "rsvp_questions" t SET "sort_order" = r.n FROM (
  SELECT id, (row_number() OVER (PARTITION BY event_id ORDER BY id) - 1)::int AS n FROM "rsvp_questions") r WHERE t.id = r.id;
UPDATE "polls" t SET "sort_order" = r.n FROM (
  SELECT id, (row_number() OVER (PARTITION BY event_id ORDER BY id) - 1)::int AS n FROM "polls") r WHERE t.id = r.id;
UPDATE "poll_options" t SET "sort_order" = r.n FROM (
  SELECT id, (row_number() OVER (PARTITION BY poll_id ORDER BY id) - 1)::int AS n FROM "poll_options") r WHERE t.id = r.id;

COMMIT;
