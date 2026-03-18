-- Stage gate rules: allow admins to define criteria documents must meet
-- before they can advance to each lifecycle stage.

ALTER TABLE "lifecycle_stages"
  ADD COLUMN IF NOT EXISTS "gate_rules" jsonb NOT NULL DEFAULT '[]';
