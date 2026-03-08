-- Agent sessions and tool calls
DO $$ BEGIN
  CREATE TYPE "agent_session_status" AS ENUM ('running', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Extend audit event type enum
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'agent_workflow';

CREATE TABLE IF NOT EXISTS "agent_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "document_id" uuid REFERENCES "documents"("id"),
  "status" "agent_session_status" NOT NULL DEFAULT 'running',
  "prompt" text NOT NULL,
  "result" text,
  "tool_call_count" integer NOT NULL DEFAULT 0,
  "token_usage" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "agent_tool_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "agent_sessions"("id"),
  "tool_name" text NOT NULL,
  "input" jsonb NOT NULL DEFAULT '{}',
  "output" jsonb NOT NULL DEFAULT '{}',
  "duration_ms" integer NOT NULL DEFAULT 0,
  "error" text,
  "sequence" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "name" text NOT NULL,
  "key_hash" text NOT NULL,
  "key_prefix" text NOT NULL,
  "scopes" jsonb NOT NULL DEFAULT '[]',
  "last_used_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "revoked" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS "agent_sessions_team_id_idx" ON "agent_sessions" ("team_id");
CREATE INDEX IF NOT EXISTS "agent_sessions_user_id_idx" ON "agent_sessions" ("user_id");
CREATE INDEX IF NOT EXISTS "agent_tool_calls_session_id_idx" ON "agent_tool_calls" ("session_id");
CREATE INDEX IF NOT EXISTS "api_keys_team_id_idx" ON "api_keys" ("team_id");
CREATE INDEX IF NOT EXISTS "api_keys_key_hash_idx" ON "api_keys" ("key_hash");
