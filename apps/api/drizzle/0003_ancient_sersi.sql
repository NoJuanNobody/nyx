CREATE TABLE "ticket_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_suggestions" ADD CONSTRAINT "ticket_suggestions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_suggestions" ADD CONSTRAINT "ticket_suggestions_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;