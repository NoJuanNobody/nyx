-- Live sync (AI-68): explicit impact edges between specs, files and tickets, and drift records
-- produced by the push -> changed files -> affected specs -> LLM verdict pipeline.

CREATE TABLE impact_edges (
    id          TEXT PRIMARY KEY,
    team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    src_kind    TEXT NOT NULL CHECK (src_kind IN ('spec','file','ticket')),
    src_ref     TEXT NOT NULL CHECK (length(src_ref) > 0),
    dst_kind    TEXT NOT NULL CHECK (dst_kind IN ('spec','file','ticket')),
    dst_ref     TEXT NOT NULL CHECK (length(dst_ref) > 0),
    relation    TEXT NOT NULL DEFAULT 'relates' CHECK (length(relation) > 0),
    weight      REAL NOT NULL DEFAULT 1.0 CHECK (weight > 0 AND weight <= 1),
    created_at  INTEGER NOT NULL,
    CHECK (NOT (src_kind = dst_kind AND src_ref = dst_ref)),
    UNIQUE (team_id, src_kind, src_ref, dst_kind, dst_ref, relation)
);
CREATE INDEX impact_edges_src_idx ON impact_edges(team_id, src_kind, src_ref);
CREATE INDEX impact_edges_dst_idx ON impact_edges(team_id, dst_kind, dst_ref);

-- One row per (run, document, document version). The unique key makes re-processing the same
-- push (webhook retries) a no-op instead of a second LLM call.
CREATE TABLE drift_records (
    id             TEXT PRIMARY KEY,
    team_id        TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    document_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    doc_version    INTEGER NOT NULL,
    run_key        TEXT NOT NULL CHECK (length(run_key) > 0),
    source         TEXT NOT NULL,
    repo_full_name TEXT,
    git_ref        TEXT,
    commit_sha     TEXT,
    has_drift      INTEGER NOT NULL CHECK (has_drift IN (0,1)),
    drift_score    REAL NOT NULL CHECK (drift_score >= 0 AND drift_score <= 10),
    details        TEXT NOT NULL DEFAULT '',
    suggestions    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(suggestions)),
    changed_files  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changed_files)),
    status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
    created_at     INTEGER NOT NULL,
    resolved_at    INTEGER,
    UNIQUE (run_key, document_id, doc_version)
);
CREATE INDEX drift_records_team_idx ON drift_records(team_id, has_drift, status);
CREATE INDEX drift_records_document_idx ON drift_records(document_id, created_at);
