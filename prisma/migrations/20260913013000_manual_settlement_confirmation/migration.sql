BEGIN;
ALTER TABLE "bets" ADD COLUMN "manualSettlementVersion" INTEGER NOT NULL DEFAULT 1 CHECK ("manualSettlementVersion" > 0);
CREATE TABLE "manual_settlement_receipts" (
  "betId" TEXT NOT NULL REFERENCES "bets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "requestId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "resultVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("betId", "requestId")
);
-- Uma revisão própria evita conflitos por updatedAt, preço externo e telemetria.
-- Inclui mudanças que voltam ao valor anterior: a revisão nunca retrocede.
CREATE FUNCTION "bump_manual_settlement_version"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."bankrollId", NEW."evento", NEW."esporte", NEW."sportResolutionStatus", NEW."competicao", NEW."pais", NEW."mercado", NEW."selecao", NEW."casaDeAposta", NEW."data", NEW."kickoffInferido", NEW."liveScoreHome", NEW."liveScoreAway", NEW."odds", NEW."stake", NEW."valorUnidade", NEW."status", NEW."lucro", NEW."legsJson", NEW."contaId", NEW."deletedAt", NEW."notTakenAt", NEW."settledAt") IS DISTINCT FROM ROW(OLD."bankrollId", OLD."evento", OLD."esporte", OLD."sportResolutionStatus", OLD."competicao", OLD."pais", OLD."mercado", OLD."selecao", OLD."casaDeAposta", OLD."data", OLD."kickoffInferido", OLD."liveScoreHome", OLD."liveScoreAway", OLD."odds", OLD."stake", OLD."valorUnidade", OLD."status", OLD."lucro", OLD."legsJson", OLD."contaId", OLD."deletedAt", OLD."notTakenAt", OLD."settledAt")
     OR NEW."manualSettlementVersion" IS DISTINCT FROM OLD."manualSettlementVersion" THEN
    NEW."manualSettlementVersion" := OLD."manualSettlementVersion" + 1;
  ELSE
    NEW."manualSettlementVersion" := OLD."manualSettlementVersion";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "manual_settlement_version" BEFORE UPDATE ON "bets"
  FOR EACH ROW EXECUTE FUNCTION "bump_manual_settlement_version"();

-- O contrato de jogador pertence à aposta; a coleta de evidência não é alteração do contrato.
CREATE FUNCTION "bump_player_manual_settlement_version"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."betId" = OLD."betId" AND NEW.terms IS NOT DISTINCT FROM OLD.terms AND NEW.rule IS NOT DISTINCT FROM OLD.rule THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    UPDATE bets SET "manualSettlementVersion" = "manualSettlementVersion" + 1 WHERE id = OLD."betId";
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP <> 'UPDATE' OR NEW."betId" <> OLD."betId") THEN
    UPDATE bets SET "manualSettlementVersion" = "manualSettlementVersion" + 1 WHERE id = NEW."betId";
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "player_manual_settlement_version" AFTER INSERT OR UPDATE OR DELETE ON "bet_player_props"
  FOR EACH ROW EXECUTE FUNCTION "bump_player_manual_settlement_version"();
COMMIT;
