-- Jobs de enrich com kickoff provisório esgotado podiam concluir sem
-- materializar o estado 1:1. Preserve bankrolls OFF, onde a ausência é intencional.
INSERT INTO "bet_sharp" ("betId", "identityStatus", "confidence", "updatedAt")
SELECT b.id, 'PENDING', 0, CURRENT_TIMESTAMP
FROM "bets" b
JOIN "bankrolls" bk ON bk.id = b."bankrollId"
LEFT JOIN "bet_sharp" s ON s."betId" = b.id
WHERE b."deletedAt" IS NULL
  AND b.status = 'PENDING'
  AND bk."sharpMode" <> 'OFF'
  AND s."betId" IS NULL
ON CONFLICT ("betId") DO NOTHING;
