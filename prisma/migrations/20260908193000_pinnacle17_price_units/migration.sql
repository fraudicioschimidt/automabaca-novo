-- Additive: existing v1 references and old writers remain valid.
-- @migration-compat previous-writer-shims
CREATE OR REPLACE FUNCTION "automabaca_valid_price_reference_v1"(
  provider_value TEXT,
  reference_value TEXT
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE
    WHEN provider_value = 'bridgeodds' THEN reference_value ~ '^bridgeodds:v1:[^:]+$'
    WHEN provider_value = 'pinnacle17' THEN
      reference_value ~ '^pinnacle17:v1:[1-9][0-9]*:(0|[1-9][0-9]*):(moneyline|spread|total|team_total):[a-z0-9_-]+:[a-z0-9_-]+$'
      OR reference_value ~ '^pinnacle17:v2:[1-9][0-9]*:(0|[1-9][0-9]*):(moneyline|spread|total|team_total):[a-z0-9_-]+:[a-z0-9_-]+:[a-z][a-z0-9_-]*$'
    ELSE FALSE
  END;
$$;
