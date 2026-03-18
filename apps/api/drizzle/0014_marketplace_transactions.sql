-- Add Stripe Connect account ID to users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_connect_account_id" text;

-- Marketplace transaction status enum
DO $$ BEGIN
  CREATE TYPE "marketplace_transaction_status" AS ENUM('pending', 'completed', 'refunded', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Marketplace transactions table
CREATE TABLE IF NOT EXISTS "marketplace_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "listing_id" uuid NOT NULL REFERENCES "marketplace_listings"("id"),
  "buyer_id" uuid NOT NULL REFERENCES "users"("id"),
  "seller_id" uuid NOT NULL REFERENCES "users"("id"),
  "amount_cents" integer NOT NULL,
  "platform_fee_cents" integer NOT NULL,
  "status" "marketplace_transaction_status" NOT NULL DEFAULT 'pending',
  "stripe_checkout_session_id" text,
  "stripe_payment_intent_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
