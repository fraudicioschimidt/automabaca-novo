-- Auditoria 009: invariantes temporais da resolução de esporte e fila PENDING.
--
-- Seis linhas legadas CONFIRMED chegaram antes de `sportResolvedAt` virar parte
-- do contrato. O backfill usa o instante de registro como evidência mais fiel;
-- depois dele, o banco passa a impedir qualquer combinação incoerente.
UPDATE "bets"
SET "sportResolvedAt" = "registradoEm"
WHERE "sportResolutionStatus" = 'CONFIRMED'
  AND "sportResolvedAt" IS NULL;

ALTER TABLE "bets"
  ALTER COLUMN "sportResolvedAt" DROP DEFAULT;

ALTER TABLE "bets" ADD CONSTRAINT "bets_sport_resolved_at_consistency"
  CHECK (
    ("sportResolutionStatus" = 'CONFIRMED' AND "sportResolvedAt" IS NOT NULL)
    OR
    ("sportResolutionStatus" <> 'CONFIRMED' AND "sportResolvedAt" IS NULL)
  );

-- Os ciclos de closing, settlement e operações varrem apostas ativas por data.
-- O índice parcial é menor que outro índice geral e exclui tombstones/terminais.
CREATE INDEX "bets_pending_active_data_idx"
  ON "bets"("data", "id")
  WHERE "status" = 'PENDING' AND "deletedAt" IS NULL;
