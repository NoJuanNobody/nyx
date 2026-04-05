ALTER TABLE "agent_sessions" ADD COLUMN "conversation_id" uuid;
CREATE INDEX IF NOT EXISTS "agent_sessions_conversation_id_idx" ON "agent_sessions" ("conversation_id");
