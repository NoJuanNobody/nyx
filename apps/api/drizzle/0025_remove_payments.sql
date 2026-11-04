-- AI-55: remove Stripe payments, subscriptions and plan gating.
-- Credits tables are kept (agent-native utility tokens). Only the Stripe-specific
-- reference column is generalised; billing tables and enums are dropped.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'credit_transactions' AND column_name = 'stripe_session_id') THEN
    ALTER TABLE "credit_transactions" RENAME COLUMN "stripe_session_id" TO "external_ref";
  END IF;
END $$;
ALTER INDEX IF EXISTS "credit_transactions_stripe_session_id_idx" RENAME TO "credit_transactions_external_ref_idx";
DROP TABLE IF EXISTS "subscriptions";
DROP TABLE IF EXISTS "stripe_customers";
DROP TYPE IF EXISTS "subscription_plan";
DROP TYPE IF EXISTS "subscription_status";
