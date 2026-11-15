CREATE TABLE "team_identities" (
    "id" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "canonicalNorm" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "pais" TEXT NOT NULL DEFAULT '',
    "legacyTeamAliasId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_identities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "team_provider_aliases" (
    "id" TEXT NOT NULL,
    "teamIdentityId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "providerNorm" TEXT NOT NULL,
    "providerTeamId" TEXT,
    "sport" TEXT NOT NULL,
    "pais" TEXT NOT NULL DEFAULT '',
    "competitionNorm" TEXT NOT NULL DEFAULT '',
    "competitionName" TEXT,
    "source" "AliasSource" NOT NULL DEFAULT 'AUTO',
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "usos" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_provider_aliases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "team_identities_legacyTeamAliasId_key"
    ON "team_identities"("legacyTeamAliasId");
CREATE INDEX "team_identities_canonicalNorm_sport_pais_idx"
    ON "team_identities"("canonicalNorm", "sport", "pais");
CREATE INDEX "team_identities_sport_pais_idx"
    ON "team_identities"("sport", "pais");
CREATE UNIQUE INDEX "team_provider_aliases_provider_providerTeamId_sport_key"
    ON "team_provider_aliases"("provider", "providerTeamId", "sport");
CREATE INDEX "team_provider_aliases_teamIdentityId_provider_idx"
    ON "team_provider_aliases"("teamIdentityId", "provider");
CREATE INDEX "team_provider_aliases_provider_providerNorm_sport_idx"
    ON "team_provider_aliases"("provider", "providerNorm", "sport");
CREATE INDEX "team_provider_aliases_provider_sport_pais_competitionNorm_idx"
    ON "team_provider_aliases"("provider", "sport", "pais", "competitionNorm");
CREATE INDEX "team_provider_aliases_source_idx"
    ON "team_provider_aliases"("source");

ALTER TABLE "team_provider_aliases"
    ADD CONSTRAINT "team_provider_aliases_teamIdentityId_fkey"
    FOREIGN KEY ("teamIdentityId") REFERENCES "team_identities"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill determinístico e idempotente do modelo legado. Um alias legado
-- começa como uma identidade independente; fusões só acontecem depois com
-- evidência de provider, nunca por semelhança textual isolada.
INSERT INTO "team_identities" (
    "id",
    "canonicalName",
    "canonicalNorm",
    "sport",
    "pais",
    "legacyTeamAliasId",
    "createdAt",
    "usedAt"
)
SELECT
    'legacy-' || ta."id",
    ta."pinnacleName",
    lower(regexp_replace(ta."pinnacleName", '[^[:alnum:]]+', ' ', 'g')),
    ta."sport",
    ta."pais",
    ta."id",
    ta."createdAt",
    ta."usedAt"
FROM "team_aliases" ta
ON CONFLICT ("legacyTeamAliasId") DO NOTHING;

INSERT INTO "team_provider_aliases" (
    "id",
    "teamIdentityId",
    "provider",
    "providerName",
    "providerNorm",
    "sport",
    "pais",
    "competitionNorm",
    "competitionName",
    "source",
    "confidence",
    "usos",
    "createdAt",
    "usedAt"
)
SELECT
    'legacy-local-' || ta."id",
    'legacy-' || ta."id",
    'LOCAL',
    ta."localNorm",
    ta."localNorm",
    ta."sport",
    ta."pais",
    ta."competitionNorm",
    ta."competitionName",
    ta."source",
    ta."confidence",
    ta."usos",
    ta."createdAt",
    ta."usedAt"
FROM "team_aliases" ta
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "team_provider_aliases" (
    "id",
    "teamIdentityId",
    "provider",
    "providerName",
    "providerNorm",
    "sport",
    "pais",
    "competitionNorm",
    "competitionName",
    "source",
    "confidence",
    "usos",
    "createdAt",
    "usedAt"
)
SELECT
    'legacy-pinnacle-' || ta."id",
    'legacy-' || ta."id",
    'PINNACLE',
    ta."pinnacleName",
    lower(regexp_replace(ta."pinnacleName", '[^[:alnum:]]+', ' ', 'g')),
    ta."sport",
    ta."pais",
    ta."competitionNorm",
    ta."competitionName",
    ta."source",
    ta."confidence",
    ta."usos",
    ta."createdAt",
    ta."usedAt"
FROM "team_aliases" ta
ON CONFLICT ("id") DO NOTHING;
