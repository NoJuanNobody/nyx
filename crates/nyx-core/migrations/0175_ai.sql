-- AI-75: BYOK provider settings, token usage log, ticket suggestions.
-- API keys are NOT stored here: they live in the profile SecretStore (OS keychain / encrypted
-- file) and are referenced by provider kind. Replaces team_ai_keys (no keys, no teams).
CREATE TABLE ai_provider_configs (
    kind        TEXT PRIMARY KEY CHECK (kind IN
        ('anthropic','openai','openrouter','ollama','openai-compatible')),
    model       TEXT NOT NULL CHECK (length(model) > 0),
    fast_model  TEXT,
    base_url    TEXT,
    is_active   INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE ai_usage_log (
    id             TEXT PRIMARY KEY,
    operation      TEXT NOT NULL,
    provider       TEXT NOT NULL,
    model          TEXT NOT NULL,
    input_tokens   INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    created_at     INTEGER NOT NULL
);
CREATE INDEX ai_usage_log_created_idx ON ai_usage_log(created_at);

CREATE TABLE ticket_suggestions (
    id             TEXT PRIMARY KEY,
    document_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    title          TEXT NOT NULL,
    description    TEXT NOT NULL,
    labels         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels)),
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','dismissed')),
    reviewed_by_id TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);
CREATE INDEX ticket_suggestions_doc_idx ON ticket_suggestions(document_id, created_at);
