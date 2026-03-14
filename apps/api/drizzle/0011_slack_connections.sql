CREATE TABLE IF NOT EXISTS "slack_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id"),
  "slack_team_id" text NOT NULL,
  "slack_bot_token" text NOT NULL,
  "trigger_emoji" text DEFAULT 'nyx',
  "monitored_channels" jsonb DEFAULT '[]'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
