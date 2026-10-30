-- AI-58: credits become agent-native utility tokens backed by an append-only ledger.
-- No purchase, pack or plan-grant path exists any more. Old balances are kept in
-- renamed legacy tables and imported once, lazily per workspace, as an owner
-- "legacy import" grant (see credits.service.ts). Drop the legacy_* tables
-- in a later migration once every workspace has been imported.
CREATE TABLE IF NOT EXISTS "credit_entries" (
  "seq" integer PRIMARY KEY NOT NULL,
  "id" text NOT NULL,
  "ts" bigint NOT NULL,
  "kind" text NOT NULL,
  "workspace_id" text NOT NULL,
  "agent_id" text,
  "idempotency_key" text NOT NULL,
  "fingerprint" text NOT NULL,
  "reservation_id" text,
  "ref_entry_id" text,
  "expires_at" bigint,
  "task_type" text,
  "memo" text DEFAULT '' NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_id" text NOT NULL,
  "prev_hash" text NOT NULL,
  "hash" text NOT NULL,
  CONSTRAINT "credit_entries_id_unique" UNIQUE("id"),
  CONSTRAINT "credit_entries_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_postings" (
  "entry_seq" integer NOT NULL REFERENCES "credit_entries"("seq"),
  "idx" integer NOT NULL,
  "account" text NOT NULL,
  "amount" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_entries_idem_idx" ON "credit_entries" ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_entries_ws_agent_idx" ON "credit_entries" ("workspace_id", "agent_id", "seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_entries_reservation_idx" ON "credit_entries" ("reservation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_entries_ref_idx" ON "credit_entries" ("ref_entry_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_postings_pk" ON "credit_postings" ("entry_seq", "idx");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_postings_account_idx" ON "credit_postings" ("account");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION credit_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS credit_entries_append_only ON "credit_entries";
--> statement-breakpoint
CREATE TRIGGER credit_entries_append_only BEFORE UPDATE OR DELETE ON "credit_entries"
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS credit_postings_append_only ON "credit_postings";
--> statement-breakpoint
CREATE TRIGGER credit_postings_append_only BEFORE UPDATE OR DELETE ON "credit_postings"
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_append_only();
--> statement-breakpoint
-- Keep old balances for the legacy import; the purchase-era transaction log and enum go.
DO $$ BEGIN
  IF to_regclass('public.credit_balances') IS NOT NULL AND to_regclass('public.legacy_credit_balances') IS NULL THEN
    ALTER TABLE "credit_balances" RENAME TO "legacy_credit_balances";
  END IF;
  IF to_regclass('public.team_credit_balances') IS NOT NULL AND to_regclass('public.legacy_team_credit_balances') IS NULL THEN
    ALTER TABLE "team_credit_balances" RENAME TO "legacy_team_credit_balances";
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "credit_transactions";
--> statement-breakpoint
DROP TYPE IF EXISTS "credit_transaction_type";
