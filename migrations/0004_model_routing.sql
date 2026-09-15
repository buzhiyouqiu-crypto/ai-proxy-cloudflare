-- Model-specific upstream routing policies.
-- quota_limit/quota_used are request units. Image requests consume `n` units;
-- chat, embedding, and other requests consume one unit.
CREATE TABLE IF NOT EXISTS model_route_policies (
    model_id TEXT PRIMARY KEY,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS model_route_rules (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    priority INTEGER NOT NULL,
    quota_limit INTEGER,
    quota_used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_route_rules_model_provider
    ON model_route_rules(model_id, provider_key);
CREATE INDEX IF NOT EXISTS idx_model_route_rules_model_priority
    ON model_route_rules(model_id, priority);
