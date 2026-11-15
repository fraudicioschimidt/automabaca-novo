-- Snapshot da unidade da banca no momento do registro.
-- DEFAULT 1 só cobre inserts legados/testes; registerBet sempre grava o valor da banca.
ALTER TABLE "bets" ADD COLUMN "valorUnidade" DECIMAL(10,2) NOT NULL DEFAULT 1;

UPDATE "bets" b
SET "valorUnidade" = k."valorUnidade"
FROM "bankrolls" k
WHERE b."bankrollId" = k.id;
