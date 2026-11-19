-- Database backstops for counts the app already keeps in range (docs/agent/orders-and-stock.md):
-- a bug or a hand edit can no longer store a negative plus-one count, a zero/negative waitlist
-- position or a negative ticket quantity. Seat capacity is a cross-row limit: it stays enforced by
-- the event-row lock (SELECT ... FOR UPDATE) in every write path.
-- No unique index on (event_id, waitlist_position): the waitlist is renumbered with one UPDATE
-- (src/server/routes/admin-guests.ts), and a non-deferrable unique index can fail mid-statement.
BEGIN;

ALTER TABLE "rsvps" ADD CONSTRAINT "rsvps_plus_ones_nonneg" CHECK ("plus_ones" >= 0);
ALTER TABLE "rsvps" ADD CONSTRAINT "rsvps_waitlist_position_positive" CHECK ("waitlist_position" IS NULL OR "waitlist_position" > 0);
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_quantity_nonneg" CHECK ("quantity" IS NULL OR "quantity" >= 0);

COMMIT;
