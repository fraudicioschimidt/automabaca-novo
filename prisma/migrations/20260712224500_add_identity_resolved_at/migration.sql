ALTER TABLE "bet_sharp" ADD COLUMN "identityResolvedAt" TIMESTAMPTZ(3);

UPDATE "bet_sharp"
SET "identityResolvedAt" = "updatedAt"
WHERE "identityStatus" <> 'PENDING';

CREATE INDEX "bet_sharp_identityResolvedAt_idx" ON "bet_sharp"("identityResolvedAt");
