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

-- Approvals. Extension over the Drizzle table: the rule that applied at creation is snapshotted
-- (min_approvals, reviewer_ids, allow_self_approval) and individual votes live in approval_reviews.
CREATE TABLE approvals (
    id                   TEXT PRIMARY KEY,
    action               TEXT NOT NULL,
    resource_id          TEXT NOT NULL,
    requested_by_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reviewed_by_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
    team_id              TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
    metadata             TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
    reason               TEXT,
    min_approvals        INTEGER NOT NULL DEFAULT 1 CHECK (min_approvals >= 1),
    reviewer_ids         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reviewer_ids)),
    allow_self_approval  INTEGER NOT NULL DEFAULT 1 CHECK (allow_self_approval IN (0,1)),
    expires_at           INTEGER NOT NULL,
    reviewed_at          INTEGER,
    created_at           INTEGER NOT NULL
);
CREATE INDEX approvals_team_idx ON approvals(team_id, created_at);
CREATE INDEX approvals_resource_idx ON approvals(team_id, action, resource_id);

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
