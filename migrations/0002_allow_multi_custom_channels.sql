-- Multiple administrator-managed custom channels may expose the same
-- canonical model. Keep fixed providers unique, while allowing custom rows
-- to retain their channel-specific upstream_model_id and pricing metadata.
DROP INDEX IF EXISTS idx_model_catalog_provider_model;

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_catalog_provider_model_fixed
    ON model_catalog(provider_id, model_id)
    WHERE provider_id <> 'custom';
