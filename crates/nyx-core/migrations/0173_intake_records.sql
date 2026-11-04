-- Intake records (AI-73): one row per piece of chaos fed into Nyx (pasted text, upload, audio,
-- image, PCB file). Replaces the hosted `intake_sessions` table with an explicit lifecycle:
-- received -> parsed -> structured | clarification_needed (-> structured), or failed (-> received).
-- Original bytes are not stored here; `sha256` identifies them and `raw_text` is the extracted text.
CREATE TABLE intake_records (
    id                TEXT PRIMARY KEY,
    team_id           TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    created_by_id     TEXT NOT NULL REFERENCES users(id),
    kind              TEXT NOT NULL CHECK (kind IN
        ('text','markdown','csv','pdf','docx','image','audio','pcb','unknown')),
    source_name       TEXT,
    mime              TEXT NOT NULL,
    size_bytes        INTEGER NOT NULL CHECK (size_bytes >= 0),
    sha256            TEXT NOT NULL CHECK (length(sha256) = 64),
    status            TEXT NOT NULL DEFAULT 'received' CHECK (status IN
        ('received','parsed','structured','clarification_needed','failed')),
    raw_text          TEXT,
    note              TEXT,
    structured_output TEXT CHECK (structured_output IS NULL OR json_valid(structured_output)),
    error             TEXT,
    document_id       TEXT REFERENCES documents(id) ON DELETE SET NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
);
CREATE INDEX intake_records_team_idx ON intake_records(team_id, created_at);
CREATE INDEX intake_records_hash_idx ON intake_records(team_id, sha256);
