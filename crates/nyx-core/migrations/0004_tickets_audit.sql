CREATE TABLE tickets (
    id               TEXT PRIMARY KEY,
    document_id      TEXT NOT NULL REFERENCES documents(id),
    provider         TEXT NOT NULL CHECK (provider IN ('github','jira','gitlab','bitbucket')),
    external_id      TEXT NOT NULL,
    external_url     TEXT NOT NULL,
    title            TEXT NOT NULL,
    body             TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','closed')),
    claude_insights  TEXT CHECK (claude_insights IS NULL OR json_valid(claude_insights)),
    created_by_id    TEXT NOT NULL REFERENCES users(id),
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);
CREATE INDEX tickets_document_idx ON tickets(document_id);

-- Append-only audit log. The in-app `agent_workflow` event type is intentionally dropped.
CREATE TABLE audit_trail (
    id               TEXT PRIMARY KEY,
    team_id          TEXT NOT NULL REFERENCES teams(id),
    event_type       TEXT NOT NULL CHECK (event_type IN (
        'doc_edit','snapshot_created','ticket_created','ticket_updated',
        'code_commit','proposal_created','proposal_approved','proposal_pushed')),
    actor_id         TEXT REFERENCES users(id),
    document_id      TEXT REFERENCES documents(id),
    snapshot_id      TEXT REFERENCES snapshots(id),
    ticket_id        TEXT REFERENCES tickets(id),
    commit_sha       TEXT,
    parent_event_id  TEXT REFERENCES audit_trail(id),
    metadata         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
    created_at       INTEGER NOT NULL
);
CREATE INDEX audit_trail_team_idx ON audit_trail(team_id, created_at);
CREATE INDEX audit_trail_document_idx ON audit_trail(document_id, created_at);
CREATE TRIGGER audit_trail_no_update BEFORE UPDATE ON audit_trail
BEGIN SELECT RAISE(ABORT, 'audit_trail is append-only'); END;
CREATE TRIGGER audit_trail_no_delete BEFORE DELETE ON audit_trail
BEGIN SELECT RAISE(ABORT, 'audit_trail is append-only'); END;
