-- Product version control (AI-70): timeline events, approvals, change proposals.

-- Drizzle `timeline_events`.
CREATE TABLE timeline_events (
    id           TEXT PRIMARY KEY,
    document_id  TEXT NOT NULL REFERENCES documents(id),
    type         TEXT NOT NULL,
    payload      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
    actor_id     TEXT REFERENCES users(id),
    created_at   INTEGER NOT NULL
);
CREATE INDEX timeline_events_document_idx ON timeline_events(document_id, created_at);

-- Drizzle `approvals`.
CREATE TABLE approvals (
    id               TEXT PRIMARY KEY,
    action           TEXT NOT NULL,
    resource_id      TEXT NOT NULL,
    requested_by_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reviewed_by_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
    team_id          TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','expired')),
    metadata         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
    reason           TEXT,
    expires_at       INTEGER NOT NULL,
    reviewed_at      INTEGER,
    created_at       INTEGER NOT NULL
);
CREATE INDEX approvals_team_idx ON approvals(team_id, status, created_at);
CREATE INDEX approvals_resource_idx ON approvals(team_id, action, resource_id, created_at);

-- Drizzle `change_proposals`. Extended with an optional content proposal that targets a branch
-- (`target_branch_id`, `base_content`, `proposed_content`) and the extra `applied` status.
CREATE TABLE change_proposals (
    id                TEXT PRIMARY KEY,
    document_id       TEXT NOT NULL REFERENCES documents(id),
    team_id           TEXT NOT NULL REFERENCES teams(id),
    created_by_id     TEXT NOT NULL REFERENCES users(id),
    title             TEXT NOT NULL,
    description       TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','pushed','applied')),
    suggested_tickets TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(suggested_tickets)),
    source_versions   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_versions)),
    target_branch_id  TEXT REFERENCES document_branches(id),
    base_content      TEXT,
    proposed_content  TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
);
CREATE INDEX change_proposals_document_idx ON change_proposals(document_id, created_at);
