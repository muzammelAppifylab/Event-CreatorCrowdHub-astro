-- Index gaps (audit L-17):
-- * the hold sweep (src/server/jobs/holds.ts) reads pending ticket orders oldest first;
-- * the contacts list and export walk guests by address (rsvps.email is always lower case,
--   CHECK rsvps_email_lower, so `email` orders and groups the same as `lower(email)`).
-- The daily invite count already has guest_email_outbox_kind_created_idx.
BEGIN;

CREATE INDEX "ticket_orders_pending_created_idx" ON "ticket_orders"("created_at") WHERE ((status)::text = 'pending'::text);
CREATE INDEX "rsvps_email_idx" ON "rsvps"("email");

COMMIT;
