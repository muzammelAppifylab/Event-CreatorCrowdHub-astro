-- Wrapped in one transaction: if any statement fails, none of them apply
-- and the live site keeps its old schema (docs/agent/database.md).
BEGIN;

ALTER TABLE "webhook_endpoints" ADD COLUMN "name" TEXT;
ALTER TABLE "webhook_endpoints" ADD COLUMN "created_at" TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE "webhook_endpoints" ADD COLUMN "last_status" INTEGER;
ALTER TABLE "webhook_endpoints" ADD COLUMN "last_delivery_at" TIMESTAMPTZ;

COMMIT;
