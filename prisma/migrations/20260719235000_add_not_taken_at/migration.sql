ALTER TABLE "bets" ADD COLUMN "notTakenAt" TIMESTAMPTZ(3);

UPDATE "bets" AS bet
SET "notTakenAt" = bet."deletedAt"
WHERE bet."deletedAt" IS NOT NULL
  AND bet."source" LIKE 'telegram-channel:%'
  AND EXISTS (
    SELECT 1
    FROM "audit_events" AS audit
    WHERE audit."resource" = 'bet'
      AND audit."resourceId" = bet."id"
      AND audit."action" = 'bet.soft_delete'
      AND audit."actor" = 'telegram-reaction'
  );

CREATE INDEX "bets_bankrollId_notTakenAt_idx" ON "bets"("bankrollId", "notTakenAt");
