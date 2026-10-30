-- Linear tickets reach the board (follow-up to AI-69).
--
-- SQLite cannot widen a CHECK constraint in place, so `tickets` is rebuilt. The documented recipe
-- (create tickets_new, copy, drop old, rename) needs foreign_keys=OFF, which cannot be changed
-- inside the runner's transaction, and renaming the old table away would make SQLite rewrite the
-- REFERENCES tickets(id) clauses of audit_trail and ticket_drafts to the new name. So: stash the
-- rows in a plain table, drop `tickets`, recreate it under the same name with the wider CHECK and
-- reinsert. defer_foreign_keys postpones constraint checks to COMMIT; re-inserting the parent rows
-- resolves every deferred violation, and a leftover violation would fail the whole migration.
-- The runner wraps this file in one transaction, so a failure leaves the old table untouched.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE tickets_stash AS SELECT * FROM tickets;
DROP TABLE tickets;

CREATE TABLE tickets (
    id               TEXT PRIMARY KEY,
    document_id      TEXT NOT NULL REFERENCES documents(id),
    provider         TEXT NOT NULL CHECK (provider IN ('github','jira','gitlab','bitbucket','linear')),
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

INSERT INTO tickets (id, document_id, provider, external_id, external_url, title, body,
                     status, claude_insights, created_by_id, created_at, updated_at)
SELECT id, document_id, provider, external_id, external_url, title, body,
       status, claude_insights, created_by_id, created_at, updated_at
FROM tickets_stash;

DROP TABLE tickets_stash;

-- Backfill: Linear drafts posted before this migration have no board row. Give each one a
-- 'linear' ticket (open; the next status sync corrects it) and link the draft to it.
CREATE TEMP TABLE linear_backfill AS
SELECT lower(substr(h,1,8) || '-' || substr(h,9,4) || '-4' || substr(h,14,3) || '-a' ||
             substr(h,18,3) || '-' || substr(h,21,12)) AS ticket_id,
       draft_id
FROM (SELECT hex(randomblob(16)) AS h, id AS draft_id
      FROM ticket_drafts
      WHERE status = 'posted' AND external_provider = 'linear' AND ticket_id IS NULL
        AND external_id IS NOT NULL AND external_url IS NOT NULL);

INSERT INTO tickets (id, document_id, provider, external_id, external_url, title, body, status,
                     claude_insights, created_by_id, created_at, updated_at)
SELECT b.ticket_id, d.document_id, 'linear', d.external_id, d.external_url, d.title, d.body,
       'open',
       json_object('draftId', d.id, 'batchId', d.batch_id, 'labels', json(d.labels)),
       d.created_by_id, d.updated_at, d.updated_at
FROM linear_backfill b JOIN ticket_drafts d ON d.id = b.draft_id;

UPDATE ticket_drafts
SET ticket_id = (SELECT b.ticket_id FROM linear_backfill b WHERE b.draft_id = ticket_drafts.id)
WHERE id IN (SELECT draft_id FROM linear_backfill);

DROP TABLE linear_backfill;
