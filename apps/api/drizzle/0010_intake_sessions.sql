CREATE TABLE IF NOT EXISTS "intake_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id"),
  "created_by_id" uuid NOT NULL REFERENCES "users"("id"),
  "raw_input" text NOT NULL,
  "structured_output" jsonb,
  "status" text NOT NULL DEFAULT 'pending',
  "document_id" uuid REFERENCES "documents"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
