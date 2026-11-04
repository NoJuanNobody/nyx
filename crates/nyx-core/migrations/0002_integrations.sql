-- Integrations (github, gitlab, ...). `config` is opaque JSON; secrets should live in the OS keychain, not here.
CREATE TABLE integrations (
    id          TEXT PRIMARY KEY,
    team_id     TEXT NOT NULL REFERENCES teams(id),
    type        TEXT NOT NULL CHECK (type IN ('github','gitlab','bitbucket','jira','confluence')),
    config      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX integrations_team_idx ON integrations(team_id);
