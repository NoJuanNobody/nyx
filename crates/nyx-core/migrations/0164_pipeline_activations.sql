-- Pipeline activations (Drizzle: user_pipeline_access). Activation is free: no credits are
-- charged, the row only records that a user switched a pipeline on. `pipeline_slug` is a lifecycle
-- slug (built-in registry or lifecycles table); deliberately no FK so a registry-only pipeline can
-- be activated before it is seeded.
CREATE TABLE pipeline_activations (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    pipeline_slug TEXT NOT NULL,
    team_id       TEXT,
    activated_at  INTEGER NOT NULL,
    UNIQUE (user_id, pipeline_slug)
);
CREATE INDEX pipeline_activations_user_idx ON pipeline_activations(user_id);
