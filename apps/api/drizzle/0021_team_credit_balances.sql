CREATE TABLE "team_credit_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"balance" integer NOT NULL DEFAULT 0,
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "team_credit_balances_team_id_unique" UNIQUE("team_id")
);
--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD COLUMN "team_id" uuid;
--> statement-breakpoint
ALTER TABLE "team_credit_balances" ADD CONSTRAINT "team_credit_balances_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;
