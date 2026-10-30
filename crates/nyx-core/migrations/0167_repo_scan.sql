-- AI-67: repo scan / onboarding / indexing.
-- Drizzle sources: onboarding_progress (TS migration 0024), background_jobs. New: scan_manifest and
-- scan_repo_state (incremental re-scan), embedding_cache (content-hash dedupe of vectors).

CREATE TABLE onboarding_progress (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    step_key     TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    UNIQUE (user_id, step_key)
);

CREATE TABLE background_jobs (
    id                TEXT PRIMARY KEY,
    team_id           TEXT REFERENCES teams(id) ON DELETE CASCADE,
    user_id           TEXT,
    type              TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','running','completed','failed','cancelled')),
    input             TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(input)),
    result            TEXT CHECK (result IS NULL OR json_valid(result)),
    error             TEXT,
    progress          INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    progress_message  TEXT,
    attempts          INTEGER NOT NULL DEFAULT 0,
    max_attempts      INTEGER NOT NULL DEFAULT 3,
    cancel_requested  INTEGER NOT NULL DEFAULT 0,
    started_at        INTEGER,
    completed_at      INTEGER,
    created_at        INTEGER NOT NULL
);
CREATE INDEX background_jobs_team_idx ON background_jobs(team_id, created_at);
CREATE INDEX background_jobs_status_idx ON background_jobs(status, created_at);

CREATE TABLE scan_manifest (
    team_id        TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    repo_full_name TEXT NOT NULL,
    path           TEXT NOT NULL,
    fingerprint    TEXT NOT NULL,
    size           INTEGER NOT NULL,
    language       TEXT NOT NULL,
    chunk_count    INTEGER NOT NULL,
    indexed_at     INTEGER NOT NULL,
    PRIMARY KEY (team_id, repo_full_name, path)
);

CREATE TABLE scan_repo_state (
    team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    repo_full_name  TEXT NOT NULL,
    head_token      TEXT,
    file_count      INTEGER NOT NULL DEFAULT 0,
    chunk_count     INTEGER NOT NULL DEFAULT 0,
    last_scanned_at INTEGER NOT NULL,
    PRIMARY KEY (team_id, repo_full_name)
);

CREATE TABLE embedding_cache (
    content_hash TEXT NOT NULL,
    model        TEXT NOT NULL,
    dim          INTEGER NOT NULL,
    embedding    BLOB NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (content_hash, model),
    CHECK (length(embedding) = dim * 4)
);
