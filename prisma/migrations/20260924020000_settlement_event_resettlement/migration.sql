-- Resultado trocado depois de liquidada: a regra num lugar só. As consultas de
-- reliquidação (lista da banca, Operações) e a trilha da aposta chamam esta
-- função. Sair de PENDING, ou de `from` ausente, é a primeira liquidação.
CREATE FUNCTION "settlement_event_is_resettlement"(event_type TEXT, payload JSONB) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT event_type = 'STATUS_CHANGED' AND coalesce(payload->>'from', 'PENDING') <> 'PENDING' $$;
