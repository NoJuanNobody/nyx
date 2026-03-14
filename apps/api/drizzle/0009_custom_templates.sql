ALTER TABLE "document_templates" ADD COLUMN "team_id" uuid REFERENCES "teams"("id");
ALTER TABLE "document_templates" ADD COLUMN "created_by_id" uuid REFERENCES "users"("id");
DROP INDEX IF EXISTS "document_templates_stage_name_idx";
CREATE UNIQUE INDEX "document_templates_stage_name_team_idx" ON "document_templates" ("stage", "name", "team_id");
