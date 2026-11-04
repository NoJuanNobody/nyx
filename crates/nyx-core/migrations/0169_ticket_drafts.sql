-- AI-69: bulk ticket review + idempotent posting.
-- A draft is a ticket proposed from a document that a human reviews, routes to a destination
-- (GitHub repo / GitLab / Bitbucket / Jira project / Linear team) and posts. The external ref is
-- recorded on the draft in the same statement that marks it posted, so a posted draft is never
-- posted twice. `tickets` rows (the board) are linked via ticket_id; Linear drafts have no
-- ticket row because tickets.provider (0004) does not allow 'linear'.
-- Supersedes the pending/approved/dismissed-only ticket_suggestions (0175) for new work; that
-- table is left untouched.
CREATE TABLE ticket_drafts (
    id                TEXT PRIMARY KEY,
    batch_id          TEXT NOT NULL,
    document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    title             TEXT NOT NULL CHECK (length(title) > 0),
    body              TEXT NOT NULL DEFAULT '',
    labels            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels)),
    dedupe_key        TEXT NOT NULL,
    destination       TEXT CHECK (destination IS NULL OR json_valid(destination)),
    destination_key   TEXT,
    status            TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','approved','posting','posted','failed','dismissed')),
    attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error        TEXT,
    outcome_unknown   INTEGER NOT NULL DEFAULT 0 CHECK (outcome_unknown IN (0,1)),
    external_provider TEXT,
    external_id       TEXT,
    external_url      TEXT,
    ticket_id         TEXT REFERENCES tickets(id),
    created_by_id     TEXT NOT NULL REFERENCES users(id),
    reviewed_by_id    TEXT REFERENCES users(id),
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    CHECK (status <> 'posted' OR (external_id IS NOT NULL AND external_url IS NOT NULL
                                  AND external_provider IS NOT NULL AND destination_key IS NOT NULL))
);
CREATE INDEX ticket_drafts_doc_idx ON ticket_drafts(document_id, created_at);
CREATE INDEX ticket_drafts_batch_idx ON ticket_drafts(batch_id);
-- One live draft per normalised title per document (dismissed drafts may be re-proposed).
CREATE UNIQUE INDEX ticket_drafts_live_uq ON ticket_drafts(document_id, dedupe_key)
    WHERE status <> 'dismissed';
-- A remote issue is recorded at most once per destination.
CREATE UNIQUE INDEX ticket_drafts_external_uq ON ticket_drafts(destination_key, external_id)
    WHERE external_id IS NOT NULL;
