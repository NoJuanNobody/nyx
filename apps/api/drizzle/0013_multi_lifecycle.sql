-- Multi-lifecycle pipeline support
-- Creates lifecycles + lifecycle_stages tables, migrates stage columns from enum to text

-- 1. Create lifecycles table
CREATE TABLE IF NOT EXISTS "lifecycles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "label" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "icon" text NOT NULL DEFAULT '',
  "is_default" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- 2. Create lifecycle_stages table
CREATE TABLE IF NOT EXISTS "lifecycle_stages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "lifecycle_id" uuid NOT NULL REFERENCES "lifecycles"("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  "label" text NOT NULL,
  "abbreviation" text NOT NULL DEFAULT '',
  "subtitle" text NOT NULL DEFAULT '',
  "color" text NOT NULL DEFAULT '',
  "text_color" text NOT NULL DEFAULT '',
  "dot_color" text NOT NULL DEFAULT '',
  "border_color" text NOT NULL DEFAULT '',
  "hex" text NOT NULL DEFAULT '#888888',
  "who" text NOT NULL DEFAULT '',
  "description" text NOT NULL DEFAULT '',
  "icon" text NOT NULL DEFAULT '',
  "ai" text NOT NULL DEFAULT '',
  "output" text NOT NULL DEFAULT '',
  "docs" jsonb NOT NULL DEFAULT '[]'
);

CREATE UNIQUE INDEX IF NOT EXISTS "lifecycle_stages_lifecycle_slug_idx"
  ON "lifecycle_stages" ("lifecycle_id", "slug");

-- 3. Insert default software_development lifecycle
INSERT INTO "lifecycles" ("id", "slug", "label", "description", "icon", "is_default", "sort_order")
VALUES (
  'a0000000-0000-4000-8000-000000000001',
  'software_development',
  'Software Development',
  'Full software product lifecycle from idea to deployed code',
  '◎',
  true,
  0
) ON CONFLICT ("slug") DO NOTHING;

-- Insert the 5 default stages
INSERT INTO "lifecycle_stages" ("lifecycle_id", "slug", "sort_order", "label", "abbreviation", "subtitle", "color", "text_color", "dot_color", "border_color", "hex", "who", "description", "icon", "ai", "output", "docs")
VALUES
  ('a0000000-0000-4000-8000-000000000001', 'conception',      0, 'Conception',      'CO', 'Idea & Vision',   'bg-amber-100',   'text-amber-700',   'bg-amber-400',   'border-amber-300',   '#E8C547', 'Product Managers, Founders',        'Capture the initial idea, problem space, and vision',                  '◎', 'Stress-tests your idea, identifies blind spots, suggests missing angles',            'Validated concept brief ready for product definition',                       '["Problem Statement","Value Proposition","Market Opportunity","Rough Concept Notes"]'),
  ('a0000000-0000-4000-8000-000000000001', 'definition',      1, 'Definition',      'DF', 'Product Spec',    'bg-teal-100',    'text-teal-700',    'bg-teal-400',    'border-teal-300',    '#4EC9B0', 'Product Managers, Designers',        'Translate the idea into a complete product specification',              '◈', 'Flags ambiguous requirements, generates user stories from PRD, scores completeness', 'Structured PRD that engineering can trust',                                  '["Product Requirements Doc (PRD)","User Stories","Personas","Feature List","Competitive Analysis"]'),
  ('a0000000-0000-4000-8000-000000000001', 'architecture',    2, 'Architecture',    'AR', 'System Design',   'bg-indigo-100',  'text-indigo-700',  'bg-indigo-400',  'border-indigo-300',  '#7B9FE0', 'Tech Leads, Senior Engineers',       'Design the system that implements the specification',                  '◫', 'Reviews architecture for gaps, suggests patterns, links decisions back to PRD intent','Architecture docs linked to every PRD requirement they serve',               '["System Architecture Doc","Data Models","API Contracts","Component Hierarchy","Tech Stack Decisions"]'),
  ('a0000000-0000-4000-8000-000000000001', 'implementation',  3, 'Implementation',  'IM', 'Dev Specs',       'bg-violet-100',  'text-violet-700',  'bg-violet-400',  'border-violet-300',  '#C084FC', 'Engineers, QA',                      'Create developer-ready specifications for AI coding agents',           '◧', 'Scores spec quality for AI code generation, auto-generates tickets, suggests edge cases','Implementation-ready specs optimized for Claude Code & Copilot',           '["AI-Ready Feature Specs","Ticket Breakdowns","Acceptance Criteria","Edge Cases","Test Plans"]'),
  ('a0000000-0000-4000-8000-000000000001', 'execution',       4, 'Execution',       'EX', 'Code & Sync',     'bg-emerald-100', 'text-emerald-700', 'bg-emerald-400', 'border-emerald-300', '#F87171', 'Engineers, DevOps',                  'Track the living codebase and keep docs in sync',                      '◉', 'Watches commits, detects doc-code drift in real time, flags intent violations',       'Codebase that never diverges silently from its original intent',             '["Living Codebase","Auto-Updated Docs","Drift Alerts","Change History","Rollback Points"]')
ON CONFLICT ("lifecycle_id", "slug") DO NOTHING;

-- 4. Add lifecycle_id columns to documents and document_templates
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "lifecycle_id" uuid REFERENCES "lifecycles"("id");
ALTER TABLE "document_templates" ADD COLUMN IF NOT EXISTS "lifecycle_id" uuid REFERENCES "lifecycles"("id");

-- 5. Convert stage columns from enum to text
ALTER TABLE "documents" ALTER COLUMN "stage" TYPE text;
ALTER TABLE "document_templates" ALTER COLUMN "stage" TYPE text;
ALTER TABLE "marketplace_listings" ALTER COLUMN "stage" TYPE text;

-- 6. Backfill lifecycle_id for documents that have a stage value (software_development)
UPDATE "documents"
  SET "lifecycle_id" = 'a0000000-0000-4000-8000-000000000001'
  WHERE "stage" IS NOT NULL AND "lifecycle_id" IS NULL;

UPDATE "document_templates"
  SET "lifecycle_id" = 'a0000000-0000-4000-8000-000000000001'
  WHERE "stage" IS NOT NULL AND "lifecycle_id" IS NULL;

-- 7. Drop the old enum type (no longer referenced by any column)
DROP TYPE IF EXISTS "document_stage";
