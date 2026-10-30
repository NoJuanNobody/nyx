-- AI-71: Slack workspace link per Nyx team. Drizzle source: slack_connections.
-- The bot token is NOT stored here (the TS version kept it encrypted in the row): it lives in the
-- OS keychain via profile::SecretStore. This table only holds non-secret metadata.
CREATE TABLE slack_connections (
    id                  TEXT PRIMARY KEY,
    team_id             TEXT NOT NULL UNIQUE REFERENCES teams(id) ON DELETE CASCADE,
    slack_team_id       TEXT NOT NULL,
    trigger_emoji       TEXT NOT NULL DEFAULT 'nyx',
    monitored_channels  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(monitored_channels)),
    created_at          INTEGER NOT NULL
);
CREATE INDEX slack_connections_slack_team_idx ON slack_connections(slack_team_id);
