ALTER TABLE "bet_sharp"
  ALTER COLUMN "openingOdd" TYPE DECIMAL(12, 6),
  ALTER COLUMN "entryFairOdd" TYPE DECIMAL(12, 6),
  ALTER COLUMN "evEntrada" TYPE DECIMAL(12, 4),
  ALTER COLUMN "evAbertura" TYPE DECIMAL(12, 4);

ALTER TABLE "bet_closing"
  ALTER COLUMN "closingOdd" TYPE DECIMAL(12, 6),
  ALTER COLUMN "clv" TYPE DECIMAL(12, 4);

-- As métricas históricas guardam mais informação que as fair odds antigas
-- (4 casas). Recupera os operandos a 6 casas para EV/CLV ser auditável a
-- partir dos valores persistidos, sem alterar a métrica já calculada.
UPDATE "bet_sharp" AS s
SET "entryFairOdd" = ROUND(b."odds" / (1 + s."evEntrada" / 100), 6)
FROM "bets" AS b
WHERE b."id" = s."betId"
  AND s."evEntrada" IS NOT NULL
  AND 1 + s."evEntrada" / 100 > 0;

UPDATE "bet_sharp" AS s
SET "openingOdd" = ROUND(b."odds" / (1 + s."evAbertura" / 100), 6)
FROM "bets" AS b
WHERE b."id" = s."betId"
  AND s."evAbertura" IS NOT NULL
  AND 1 + s."evAbertura" / 100 > 0;

UPDATE "bet_closing" AS c
SET "closingOdd" = ROUND(b."odds" / (1 + c."clv" / 100), 6)
FROM "bets" AS b
WHERE b."id" = c."betId"
  AND c."clv" IS NOT NULL
  AND 1 + c."clv" / 100 > 0;
