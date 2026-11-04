-- Documents, immutable versions, branches, code snapshots.
CREATE TABLE documents (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    path            TEXT NOT NULL DEFAULT '/',
    team_id         TEXT NOT NULL REFERENCES teams(id),
    created_by_id   TEXT NOT NULL REFERENCES users(id),
    stage           TEXT,
    lifecycle_id    TEXT REFERENCES lifecycles(id),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    deleted_at      INTEGER            -- soft-delete tombstone; NULL = live
);
CREATE INDEX documents_team_idx ON documents(team_id, deleted_at);
CREATE INDEX documents_stage_idx ON documents(team_id, stage);

CREATE TABLE document_versions (
    id             TEXT PRIMARY KEY,
    document_id    TEXT NOT NULL REFERENCES documents(id),
    version        INTEGER NOT NULL CHECK (version >= 1),
    content        TEXT NOT NULL,
    message        TEXT,
    created_by_id  TEXT NOT NULL REFERENCES users(id),
    created_at     INTEGER NOT NULL,
    UNIQUE (document_id, version)
);

-- Versions are immutable history.
CREATE TRIGGER document_versions_no_update BEFORE UPDATE ON document_versions
BEGIN SELECT RAISE(ABORT, 'document_versions is immutable'); END;

CREATE TABLE document_branches (
    id               TEXT PRIMARY KEY,
    document_id      TEXT NOT NULL REFERENCES documents(id),
    name             TEXT NOT NULL,
    base_version_id  TEXT NOT NULL REFERENCES document_versions(id),
    content          TEXT NOT NULL,
    created_by_id    TEXT NOT NULL REFERENCES users(id),
    status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','in_review','approved','rejected','merged')),
    reviewed_by_id   TEXT REFERENCES users(id),
    created_at       INTEGER NOT NULL,
    merged_at        INTEGER,
    UNIQUE (document_id, name)
);

CREATE TABLE snapshots (
    id              TEXT PRIMARY KEY,
    document_id     TEXT NOT NULL REFERENCES documents(id),
    integration_id  TEXT REFERENCES integrations(id),
    external_ref    TEXT NOT NULL,
    content         TEXT NOT NULL,
    captured_at     INTEGER NOT NULL
);
CREATE INDEX snapshots_document_idx ON snapshots(document_id, captured_at);
