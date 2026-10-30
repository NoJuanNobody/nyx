-- Explicit folders for the document tree plus manual sibling ordering.
-- Folders are also implied by `documents.path`; a row here lets an empty folder exist and
-- carries its manual order. Paths are normalised absolute paths ("/a/b"), unique per team.
CREATE TABLE folders (
    id          TEXT PRIMARY KEY,
    team_id     TEXT NOT NULL REFERENCES teams(id),
    path        TEXT NOT NULL CHECK (path LIKE '/_%'),
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (team_id, path)
);
CREATE INDEX folders_team_idx ON folders(team_id, path);

-- Manual order among siblings; ties fall back to title.
ALTER TABLE documents ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
