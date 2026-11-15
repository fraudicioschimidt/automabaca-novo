-- AlterTable
ALTER TABLE "bets" ADD COLUMN     "settledAt" TIMESTAMPTZ(3);

-- Backfill: apostas já resolvidas (não-PENDING) recebem settledAt = updatedAt — melhor
-- aproximação disponível p/ o histórico; daqui pra frente o settle grava o valor exato.
UPDATE "bets" SET "settledAt" = "updatedAt"
WHERE "status" <> 'PENDING' AND "deletedAt" IS NULL;

-- CreateIndex
CREATE INDEX "bets_status_settledAt_idx" ON "bets"("status", "settledAt");
