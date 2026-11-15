-- Expand-only: a release anterior continua escrevendo sem as colunas novas.
ALTER TABLE "team_provider_aliases"
  ADD COLUMN "aplicacoes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rejeicoes" INTEGER NOT NULL DEFAULT 0;

-- O contador histórico media aplicações que chegaram a algum candidato. Ele é
-- a melhor linha de base disponível para a nova telemetria, sem reclassificar
-- retroativamente aceitações/rejeições que não foram persistidas separadamente.
UPDATE "team_provider_aliases" SET "aplicacoes" = "usos";

ALTER TABLE "match_cache"
  ADD COLUMN "homeTeamIdentityId" TEXT,
  ADD COLUMN "awayTeamIdentityId" TEXT;

-- Backfill fail-closed: uma grafia só é ligada quando possui exatamente uma
-- identidade no grafo inteiro. Homônimos/conflitos permanecem nulos e seguem
-- pelo caminho textual legado até curadoria ou aprendizado posterior.
WITH aliases_univocos AS (
  SELECT "providerNorm", sport, MIN("teamIdentityId") AS "teamIdentityId"
  FROM "team_provider_aliases"
  GROUP BY "providerNorm", sport
  HAVING COUNT(DISTINCT "teamIdentityId") = 1
)
UPDATE "match_cache" cache
SET "homeTeamIdentityId" = casa."teamIdentityId",
    "awayTeamIdentityId" = fora."teamIdentityId"
FROM aliases_univocos casa, aliases_univocos fora
WHERE casa."providerNorm" = cache."localHomeNorm"
  AND casa.sport = cache.sport
  AND fora."providerNorm" = cache."localAwayNorm"
  AND fora.sport = cache.sport
  AND casa."teamIdentityId" <> fora."teamIdentityId";

CREATE INDEX "match_cache_provider_identity_pair_sport_date_idx"
  ON "match_cache"(
    "provider", "homeTeamIdentityId", "awayTeamIdentityId", sport, "matchDateKey"
  );
