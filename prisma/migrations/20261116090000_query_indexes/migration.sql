-- The admin refunds queue counts and pages refund_due orders newest first; polls are listed,
-- counted and reordered per event by sort_order. Neither had an index for that shape.
BEGIN;

CREATE INDEX "ticket_orders_refund_due_idx" ON "ticket_orders"("created_at" DESC, "id" DESC) WHERE ((status)::text = 'refund_due'::text);

CREATE INDEX "polls_event_sort_idx" ON "polls"("event_id", "sort_order", "id");

COMMIT;
