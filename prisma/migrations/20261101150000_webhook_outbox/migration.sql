-- Durable queue for webhook deliveries the platform would not queue (job rate limit) or a receiver failed.
BEGIN;

CREATE TABLE "webhook_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "endpoint_id" UUID NOT NULL,
    "event" VARCHAR(40) NOT NULL,
    "delivery_id" VARCHAR(64) NOT NULL,
    "body" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webhook_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webhook_outbox_endpoint_id_delivery_id_key" ON "webhook_outbox"("endpoint_id", "delivery_id");
CREATE INDEX "webhook_outbox_next_attempt_at_idx" ON "webhook_outbox"("next_attempt_at");

ALTER TABLE "webhook_outbox" ADD CONSTRAINT "webhook_outbox_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
