-- AI-76: in-app notification inbox, preferences, email delivery log, approvals, feedback.
-- Drizzle sources: notifications, notification_preferences, email_delivery_log, approvals,
-- feedback_submissions. Slack delivery is dropped (desktop notifications replace it).

CREATE TABLE notifications (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT,
    metadata    TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
    entity_id   TEXT,
    read_at     INTEGER,
    created_at  INTEGER NOT NULL
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at);
CREATE INDEX notifications_dedup_idx ON notifications(user_id, event_type, entity_id);

CREATE TABLE notification_preferences (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type     TEXT NOT NULL,
    in_app         INTEGER NOT NULL DEFAULT 1 CHECK (in_app IN (0,1)),
    email_enabled  INTEGER NOT NULL DEFAULT 1 CHECK (email_enabled IN (0,1)),
    email_mode     TEXT NOT NULL DEFAULT 'daily' CHECK (email_mode IN ('instant','daily','weekly','off')),
    updated_at     INTEGER NOT NULL,
    UNIQUE (user_id, event_type)
);

CREATE TABLE email_delivery_log (
    id               TEXT PRIMARY KEY,
    notification_id  TEXT REFERENCES notifications(id) ON DELETE SET NULL,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id      TEXT,
    status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','bounced')),
    sent_at          INTEGER,
    error            TEXT,
    created_at       INTEGER NOT NULL
);
CREATE INDEX email_delivery_user_idx ON email_delivery_log(user_id, status);

-- Approvals: the base `approvals` table is created by 0170_vcs (AI-70). The governance
-- module (AI-76) extends it: the rule that applied at creation is snapshotted and
-- individual votes live in approval_reviews.
ALTER TABLE approvals ADD COLUMN min_approvals INTEGER NOT NULL DEFAULT 1 CHECK (min_approvals >= 1);
ALTER TABLE approvals ADD COLUMN reviewer_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reviewer_ids));
ALTER TABLE approvals ADD COLUMN allow_self_approval INTEGER NOT NULL DEFAULT 1 CHECK (allow_self_approval IN (0,1));

CREATE TABLE approval_reviews (
    id           TEXT PRIMARY KEY,
    approval_id  TEXT NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
    reviewer_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    decision     TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
    reason       TEXT,
    created_at   INTEGER NOT NULL,
    UNIQUE (approval_id, reviewer_id)
);

CREATE TABLE feedback_submissions (
    id                    TEXT PRIMARY KEY,
    user_id               TEXT NOT NULL REFERENCES users(id),
    raw_message           TEXT NOT NULL,
    formatted_title       TEXT NOT NULL,
    formatted_body        TEXT NOT NULL,
    category              TEXT NOT NULL,
    github_issue_url      TEXT,
    github_issue_number   INTEGER,
    created_at            INTEGER NOT NULL
);
CREATE INDEX feedback_user_idx ON feedback_submissions(user_id, created_at);
