-- Embedding storage replacing pgvector (GH #285). Vectors are little-endian f32 BLOBs; similarity
-- search is brute force in Rust today. TODO: swap for sqlite-vec once its loadable extension is bundled.
CREATE TABLE doc_chunks (
    id               TEXT PRIMARY KEY,
    doc_id           TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    org_id           TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    content          TEXT NOT NULL,
    embedding        BLOB,
    embedding_dim    INTEGER,
    embedding_model  TEXT,
    version          INTEGER NOT NULL,
    chunk_index      INTEGER NOT NULL,
    created_at       INTEGER NOT NULL,
    CHECK ((embedding IS NULL) = (embedding_dim IS NULL)),
    CHECK (embedding IS NULL OR length(embedding) = embedding_dim * 4)
);
CREATE INDEX doc_chunks_doc_version_idx ON doc_chunks(doc_id, version);
CREATE INDEX doc_chunks_org_idx ON doc_chunks(org_id);

CREATE TABLE code_chunks (
    id               TEXT PRIMARY KEY,
    team_id          TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    file_path        TEXT NOT NULL,
    content          TEXT NOT NULL,
    embedding        BLOB,
    embedding_dim    INTEGER,
    embedding_model  TEXT,
    repo_full_name   TEXT NOT NULL,
    commit_sha       TEXT,
    chunk_index      INTEGER NOT NULL,
    created_at       INTEGER NOT NULL,
    CHECK ((embedding IS NULL) = (embedding_dim IS NULL)),
    CHECK (embedding IS NULL OR length(embedding) = embedding_dim * 4)
);
CREATE INDEX code_chunks_team_repo_idx ON code_chunks(team_id, repo_full_name);
