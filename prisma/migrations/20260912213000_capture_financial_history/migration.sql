BEGIN;

CREATE TABLE "capture_financial_contexts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "source" TEXT NOT NULL,
  "sourceExternalId" TEXT NOT NULL,
  "bankrollId" TEXT NOT NULL REFERENCES "bankrolls"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "valorUnidade" DECIMAL(10,2) NOT NULL CHECK ("valorUnidade" > 0 AND "valorUnidade" <= 99999999.99),
  "stakePolicy" "CaptureStakePolicy" NOT NULL,
  "defaultStakeUnits" DECIMAL(14,6),
  "imageStakeAsUnits" BOOLEAN NOT NULL DEFAULT false,
  "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "capture_financial_context_settings_check" CHECK (
    ("defaultStakeUnits" IS NULL OR "defaultStakeUnits" > 0 AND "defaultStakeUnits" <= 100)
    AND ("stakePolicy" = 'MESSAGE' OR "defaultStakeUnits" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "capture_financial_contexts_source_sourceExternalId_key" ON "capture_financial_contexts"("source", "sourceExternalId");
CREATE INDEX "capture_financial_contexts_bankrollId_idx" ON "capture_financial_contexts"("bankrollId");

ALTER TABLE "bets"
  ADD COLUMN "captureFinancialContextId" TEXT,
  ADD COLUMN "captureStakeSnapshot" JSONB,
  ADD COLUMN "manualStakeOverride" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "manualOddsOverride" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT "bets_captureFinancialContextId_fkey" FOREIGN KEY ("captureFinancialContextId") REFERENCES "capture_financial_contexts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "bets_captureFinancialContextId_idx" ON "bets"("captureFinancialContextId");

-- Backfill exclusivamente da evidência existente. Sem consulta à banca atual,
-- sem alterar stake/unidade/resultado; ausência ou JSON inválido permanece NULL.
CREATE FUNCTION pg_temp.valid_capture_stake_snapshot(s JSONB) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE d NUMERIC;
BEGIN
  IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR s->'version' IS DISTINCT FROM '1'::jsonb
     OR COALESCE(s->>'stakePolicy', '') NOT IN ('MESSAGE','WHEN_MISSING','ALWAYS')
     OR COALESCE(s->>'source', '') NOT IN ('message','bankroll_default','bankroll_fixed')
     OR COALESCE(jsonb_typeof(s->'originalStake'), '') NOT IN ('number','null')
     OR COALESCE(jsonb_typeof(s->'defaultStakeUnits'), '') NOT IN ('number','null') THEN RETURN false; END IF;
  IF jsonb_typeof(s->'defaultStakeUnits') = 'number' THEN
    d := (s->>'defaultStakeUnits')::numeric;
    IF d <= 0 OR d > 100 OR round(d,6) <> d THEN RETURN false; END IF;
  ELSIF s->>'stakePolicy' <> 'MESSAGE' THEN RETURN false;
  END IF;
  RETURN true;
END $$;
-- A auditoria de criação tem retenção maior. Só usar uma política comprovada
-- e sem versões contraditórias; não reconstruir a partir da configuração atual.
UPDATE "bets" b SET "captureStakeSnapshot" = x.snapshot || '{"basis":"LEGACY_EVIDENCE"}'::jsonb
FROM (
  SELECT "resourceId", (jsonb_agg(DISTINCT snapshot))->0 AS snapshot FROM (
    SELECT "betId" AS "resourceId", "parsedJson"->'stakePolicySnapshot' AS snapshot
    FROM "bet_capture_evidence" WHERE pg_temp.valid_capture_stake_snapshot("parsedJson"->'stakePolicySnapshot')
    UNION ALL
    SELECT "resourceId", details->'stakePolicySnapshot' AS snapshot
    FROM "audit_events" WHERE action = 'bet.create' AND resource = 'bet'
      AND pg_temp.valid_capture_stake_snapshot(details->'stakePolicySnapshot')
  ) candidates GROUP BY "resourceId" HAVING count(DISTINCT snapshot) = 1
) x WHERE x."resourceId" = b.id AND b."captureStakeSnapshot" IS NULL;

-- Correção manual comprovável pela auditoria do writer do painel. Eventos
-- ausentes não são fabricados; sem política conhecida a edição preserva stake.
UPDATE "bets" b SET
  "manualStakeOverride" = x.stake,
  "manualOddsOverride" = x.odds
FROM (
  SELECT "resourceId", bool_or(details->'antes'->'stake' IS DISTINCT FROM details->'depois'->'stake') AS stake,
    bool_or(details->'antes'->'odds' IS DISTINCT FROM details->'depois'->'odds') AS odds
  FROM "audit_events" WHERE action = 'bet.edit' AND resource = 'bet'
    AND details->'depois'->>'sportSource' = 'MANUAL'
    AND actor NOT IN ('sport-resolver','telegram-edit','telegram-player-edit')
    AND details->'antes' ? 'stake' AND details->'depois' ? 'stake'
    AND details->'antes' ? 'odds' AND details->'depois' ? 'odds'
  GROUP BY "resourceId"
) x WHERE x."resourceId" = b.id;

CREATE FUNCTION "guard_capture_financial_context_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Capture financial context is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "capture_financial_context_immutable" BEFORE UPDATE ON "capture_financial_contexts"
  FOR EACH ROW EXECUTE FUNCTION "guard_capture_financial_context_immutable"();

COMMIT;
