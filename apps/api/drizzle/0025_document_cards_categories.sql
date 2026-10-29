-- Migration: document_categories + document_cards (issue #396)
-- Adds the Category and Card entities completed in the System Architecture Document.

--> statement-breakpoint
CREATE TABLE "document_categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "color" text DEFAULT '#6366f1' NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_categories"
  ADD CONSTRAINT "document_categories_team_id_teams_id_fk"
  FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_categories"
  ADD CONSTRAINT "document_categories_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "document_categories_team_slug_idx"
  ON "document_categories" ("team_id", "slug");
--> statement-breakpoint
CREATE TABLE "document_cards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "category_id" uuid,
  "template_id" uuid,
  "artwork_urls" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "is_published" boolean DEFAULT false NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by" uuid NOT NULL,
  "team_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_cards"
  ADD CONSTRAINT "document_cards_category_id_document_categories_id_fk"
  FOREIGN KEY ("category_id") REFERENCES "public"."document_categories"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_cards"
  ADD CONSTRAINT "document_cards_template_id_document_templates_id_fk"
  FOREIGN KEY ("template_id") REFERENCES "public"."document_templates"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_cards"
  ADD CONSTRAINT "document_cards_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_cards"
  ADD CONSTRAINT "document_cards_team_id_teams_id_fk"
  FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "document_cards_category_id_idx"
  ON "document_cards" ("category_id");
--> statement-breakpoint
CREATE INDEX "document_cards_is_published_idx"
  ON "document_cards" ("is_published");
--> statement-breakpoint
CREATE INDEX "document_cards_team_created_by_idx"
  ON "document_cards" ("team_id", "created_by");
