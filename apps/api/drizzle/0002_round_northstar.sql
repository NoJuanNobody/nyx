ALTER TABLE "document_branches" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_branches" ADD COLUMN "reviewed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "document_branches" ADD CONSTRAINT "document_branches_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;