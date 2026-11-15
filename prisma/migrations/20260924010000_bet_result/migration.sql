-- Resultado externo em tabela própria: `bet_closing` guardava preço e placar
-- juntos. Aditiva: as escritas passam a gravar nas duas tabelas, e os
-- leitores continuam em `bet_closing` até a cópia conferir sem divergência.
CREATE TABLE "bet_result" (
    "betId" TEXT NOT NULL,
    "scoreHome" INTEGER,
    "scoreAway" INTEGER,
    "resultProvider" TEXT,
    "resultMatchId" TEXT,
    "resultMatchConfidence" DECIMAL(5,4),
    "resultSnapshot" JSONB,
    "resultCheckedAt" TIMESTAMPTZ(3),
    "resultFinal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bet_result_pkey" PRIMARY KEY ("betId"),
    CONSTRAINT "bet_result_result_match_confidence_check" CHECK (
        "resultMatchConfidence" IS NULL
        OR ("resultMatchConfidence" >= 0 AND "resultMatchConfidence" <= 1)
    )
);

CREATE INDEX "bet_result_resultCheckedAt_idx" ON "bet_result"("resultCheckedAt");

ALTER TABLE "bet_result" ADD CONSTRAINT "bet_result_betId_fkey" FOREIGN KEY ("betId") REFERENCES "bets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
