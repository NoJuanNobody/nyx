-- Drop the document_status enum and replace the archived state with a
-- deleted_at tombstone on the documents table.
--
-- The draft/published/archived enum was half-implemented: the frontend had no
-- UI to transition a document to `published`, so every document lived in
-- `draft` forever. `archived` was only used as a soft-delete tombstone from
-- the DELETE endpoint. This migration:
--
--   1. Adds `deleted_at timestamp with time zone` to `documents`
--   2. Backfills `deleted_at = updated_at` for any row that was `archived`
--   3. Drops the `status` column
--   4. Drops the `document_status` enum type

ALTER TABLE "documents" ADD COLUMN "deleted_at" timestamp with time zone;

UPDATE "documents"
SET "deleted_at" = "updated_at"
WHERE "status" = 'archived';

ALTER TABLE "documents" DROP COLUMN "status";

DROP TYPE IF EXISTS "document_status";
