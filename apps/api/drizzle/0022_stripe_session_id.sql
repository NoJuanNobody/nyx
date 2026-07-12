ALTER TABLE "credit_transactions" ADD COLUMN "stripe_session_id" text;
CREATE UNIQUE INDEX IF NOT EXISTS "credit_transactions_stripe_session_id_idx" ON "credit_transactions" ("stripe_session_id");
