ALTER TABLE "bet_sharp"
  ADD COLUMN "entryRawOdd" DECIMAL(10,4);

-- Reconstrói o histórico possível a partir da relação que originou o campo
-- legado. Novos enrichments persistem a raw diretamente, sem depender disso.
UPDATE "bet_sharp" AS bs
SET "entryRawOdd" = ROUND(
  (b.odds / (1 + bs."houseEdgeBps"::numeric / 10000))::numeric,
  4
)
FROM bets AS b
WHERE b.id = bs."betId"
  AND bs."houseEdgeBps" IS NOT NULL
  AND bs."houseEdgeBps" > -10000
  AND b.odds / (1 + bs."houseEdgeBps"::numeric / 10000) > 1;
