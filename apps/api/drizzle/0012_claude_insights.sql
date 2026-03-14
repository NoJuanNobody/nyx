ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "claude_insights" jsonb DEFAULT NULL;
