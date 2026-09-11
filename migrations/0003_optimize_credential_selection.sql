-- Optimize owner-scoped credential selection without changing routing semantics.
-- The existing provider index remains useful for platform-wide pool selection;
-- this composite index covers the more selective owner-scoped path.
CREATE INDEX IF NOT EXISTS idx_credentials_provider_owner_status
    ON upstream_credentials(provider_id, owner_id, is_enabled, health_status, price_multiplier);
