-- Identity (users, teams, members) and lifecycles. Ported from Drizzle schema.ts.
-- Conventions: ids are TEXT (uuid v4), timestamps are INTEGER unix milliseconds (UTC),
-- booleans are INTEGER 0/1, jsonb columns are TEXT guarded by json_valid().

CREATE TABLE users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    avatar_url  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE teams (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE team_members (
    id        TEXT PRIMARY KEY,
    team_id   TEXT NOT NULL REFERENCES teams(id),
    user_id   TEXT NOT NULL REFERENCES users(id),
    role      TEXT NOT NULL DEFAULT 'viewer'
              CHECK (role IN ('owner','admin','developer','editor','viewer')),
    joined_at INTEGER NOT NULL,
    UNIQUE (team_id, user_id)
);
CREATE INDEX team_members_user_idx ON team_members(user_id);

CREATE TABLE lifecycles (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    label       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon        TEXT NOT NULL DEFAULT '',
    is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);
-- At most one default lifecycle.
CREATE UNIQUE INDEX lifecycles_single_default_idx ON lifecycles(is_default) WHERE is_default = 1;

CREATE TABLE lifecycle_stages (
    id            TEXT PRIMARY KEY,
    lifecycle_id  TEXT NOT NULL REFERENCES lifecycles(id) ON DELETE CASCADE,
    slug          TEXT NOT NULL,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    label         TEXT NOT NULL,
    abbreviation  TEXT NOT NULL DEFAULT '',
    subtitle      TEXT NOT NULL DEFAULT '',
    color         TEXT NOT NULL DEFAULT '',
    text_color    TEXT NOT NULL DEFAULT '',
    dot_color     TEXT NOT NULL DEFAULT '',
    border_color  TEXT NOT NULL DEFAULT '',
    hex           TEXT NOT NULL DEFAULT '#888888',
    who           TEXT NOT NULL DEFAULT '',
    description   TEXT NOT NULL DEFAULT '',
    icon          TEXT NOT NULL DEFAULT '',
    ai            TEXT NOT NULL DEFAULT '',
    output        TEXT NOT NULL DEFAULT '',
    docs          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(docs)),
    UNIQUE (lifecycle_id, slug)
);
