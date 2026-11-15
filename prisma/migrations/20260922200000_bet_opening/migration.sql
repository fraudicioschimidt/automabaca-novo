-- Abertura da Pinnacle com procedência própria (22/09/2026). Sem EV de
-- entrada, a identidade e o CLV vêm da Pinnacle17, que não tem abertura; a
-- abertura vem da BridgeOdds, buscada depois do jogo. Tabela nova, sem tocar
-- em dado existente: o código antigo não a lê.
BEGIN;
CREATE TABLE bet_opening (
  "betId" TEXT PRIMARY KEY REFERENCES bets(id) ON DELETE CASCADE ON UPDATE CASCADE,
  provider TEXT,
  "priceReference" TEXT,
  "openingOdd" DECIMAL(12,6),
  "openingRawOdd" DECIMAL(10,4),
  "openingPriceSnapshot" JSONB,
  "openingPriceObservedAt" TIMESTAMPTZ(3),
  "openingMaxBet" INTEGER,
  "openingMaxBetCurrency" TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "lastAttemptAt" TIMESTAMPTZ(3),
  "noOpeningReason" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT bet_opening_price_provenance_check CHECK (
    (
      "openingOdd" IS NULL AND "openingRawOdd" IS NULL AND "openingPriceSnapshot" IS NULL
      AND "openingPriceObservedAt" IS NULL AND "openingMaxBet" IS NULL AND "openingMaxBetCurrency" IS NULL
    ) OR (
      "openingOdd" > 1 AND "openingRawOdd" > 1
      AND jsonb_typeof("openingPriceSnapshot") = 'object'
      AND "openingPriceSnapshot"->>'version' = '1'
      AND jsonb_typeof("openingPriceSnapshot"->'components') = 'array'
      AND "openingPriceObservedAt" IS NOT NULL
      AND provider IS NOT NULL AND "priceReference" IS NOT NULL
      AND "automabaca_valid_price_reference_v1"(provider, "priceReference")
    )
  )
);
CREATE INDEX ON bet_opening ("lastAttemptAt");
COMMIT;
