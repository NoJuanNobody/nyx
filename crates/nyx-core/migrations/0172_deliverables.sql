-- Generated deliverables per document and lifecycle stage (Drizzle: `deliverables`).
-- The bytes are not stored: they are re-rendered on demand from the document, `file_url` is a
-- stable logical reference (`/deliverables/<document_id>/<file_name>`).
CREATE TABLE deliverables (
    id            TEXT PRIMARY KEY,
    document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    stage         TEXT NOT NULL,
    type          TEXT NOT NULL CHECK (type IN
        ('pdf','markdown','report','jupyter','docx','latex','txt')),
    file_name     TEXT NOT NULL,
    file_url      TEXT NOT NULL,
    generated_at  INTEGER NOT NULL,
    metadata      TEXT
);
CREATE INDEX deliverables_document_idx ON deliverables(document_id, generated_at);
