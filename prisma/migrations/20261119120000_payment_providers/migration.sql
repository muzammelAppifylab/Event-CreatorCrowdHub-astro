-- The owner's own payment provider (docs/agent/payments-providers.md): the pick (one row), the
-- prices made at the provider for ticket types, each webhook event once, and one checkout row per
-- attempt (its id is the provider's `ref`, the idempotency key and the ticket order's checkout id).
-- No key, card or email in any of them.
BEGIN;

CREATE TABLE "provider_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "provider" VARCHAR(10),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "provider_settings_single_row" CHECK ("id" = 1),
    CONSTRAINT "provider_settings_provider_check" CHECK ("provider" IS NULL OR "provider" IN ('ezypay', 'stripe', 'paypal'))
);

CREATE TABLE "provider_prices" (
    "id" SERIAL NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "provider" VARCHAR(10) NOT NULL,
    "mode" VARCHAR(4) NOT NULL,
    "provider_price_id" VARCHAR(120) NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "interval" VARCHAR(8) NOT NULL DEFAULT 'one_time',
    "ticket_type_id" UUID,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_prices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provider_prices_provider_mode_key_key" ON "provider_prices"("provider", "mode", "key");

CREATE TABLE "provider_events" (
    "provider" VARCHAR(10) NOT NULL,
    "event_id" VARCHAR(120) NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_events_pkey" PRIMARY KEY ("provider", "event_id")
);

CREATE TABLE "provider_checkouts" (
    "id" VARCHAR(40) NOT NULL,
    "rsvp_id" UUID NOT NULL,
    "price_id" INTEGER NOT NULL,
    "provider" VARCHAR(10) NOT NULL,
    "mode" VARCHAR(4) NOT NULL,
    "provider_ref" VARCHAR(120),
    "provider_payment_id" VARCHAR(120),
    "seats" SMALLINT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'open',
    "step" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_checkouts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provider_checkouts_provider_provider_ref_key" ON "provider_checkouts"("provider", "provider_ref");

CREATE INDEX "provider_checkouts_provider_provider_payment_id_idx" ON "provider_checkouts"("provider", "provider_payment_id");

CREATE INDEX "provider_checkouts_rsvp_id_idx" ON "provider_checkouts"("rsvp_id");

CREATE INDEX "provider_checkouts_price_id_idx" ON "provider_checkouts"("price_id");

ALTER TABLE "provider_checkouts" ADD CONSTRAINT "provider_checkouts_rsvp_id_fkey" FOREIGN KEY ("rsvp_id") REFERENCES "rsvps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "provider_checkouts" ADD CONSTRAINT "provider_checkouts_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "provider_prices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
