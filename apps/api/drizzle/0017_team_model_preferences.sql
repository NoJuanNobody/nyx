-- Per-team LLM model preferences
-- Adds nullable default_model / fast_model columns to the teams table so each
-- team can choose which OpenRouter model id to use (e.g. "anthropic/claude-sonnet-4").
-- Null means "use the platform default model".

ALTER TABLE "teams" ADD COLUMN "default_model" text;
ALTER TABLE "teams" ADD COLUMN "fast_model" text;
