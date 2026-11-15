-- AlterTable
ALTER TABLE "bankrolls" ADD COLUMN     "imageStakeAsUnits" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "playerPropsAutoSettlement" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "player_identities" (
    "id" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'flashscore',
    "providerPlayerId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_provider_aliases" (
    "id" TEXT NOT NULL,
    "playerIdentityId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "source" "AliasSource" NOT NULL DEFAULT 'AUTO',
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_provider_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_match_appearances" (
    "playerIdentityId" TEXT NOT NULL,
    "providerMatchId" TEXT NOT NULL,
    "providerTeamId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "evidence" JSONB NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "player_match_appearances_pkey" PRIMARY KEY ("playerIdentityId","providerMatchId")
);

-- CreateTable
CREATE TABLE "bet_player_props" (
    "betId" TEXT NOT NULL,
    "terms" JSONB NOT NULL,
    "rule" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "playerIdentityId" TEXT,
    "providerMatchId" TEXT,
    "resolutionStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "evidence" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bet_player_props_pkey" PRIMARY KEY ("betId")
);

-- CreateIndex
CREATE UNIQUE INDEX "player_identities_provider_providerPlayerId_sport_key" ON "player_identities"("provider", "providerPlayerId", "sport");

-- CreateIndex
CREATE INDEX "player_provider_aliases_provider_normalizedName_idx" ON "player_provider_aliases"("provider", "normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "player_provider_aliases_playerIdentityId_provider_normalize_key" ON "player_provider_aliases"("playerIdentityId", "provider", "normalizedName");

-- CreateIndex
CREATE INDEX "player_match_appearances_providerMatchId_providerTeamId_idx" ON "player_match_appearances"("providerMatchId", "providerTeamId");

-- CreateIndex
CREATE INDEX "bet_player_props_playerIdentityId_resolutionStatus_idx" ON "bet_player_props"("playerIdentityId", "resolutionStatus");

-- CreateIndex
CREATE INDEX "bet_player_props_providerMatchId_idx" ON "bet_player_props"("providerMatchId");

-- AddForeignKey
ALTER TABLE "player_provider_aliases" ADD CONSTRAINT "player_provider_aliases_playerIdentityId_fkey" FOREIGN KEY ("playerIdentityId") REFERENCES "player_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_match_appearances" ADD CONSTRAINT "player_match_appearances_playerIdentityId_fkey" FOREIGN KEY ("playerIdentityId") REFERENCES "player_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bet_player_props" ADD CONSTRAINT "bet_player_props_betId_fkey" FOREIGN KEY ("betId") REFERENCES "bets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bet_player_props" ADD CONSTRAINT "bet_player_props_playerIdentityId_fkey" FOREIGN KEY ("playerIdentityId") REFERENCES "player_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "player_provider_aliases" ADD CONSTRAINT "player_alias_confidence_check" CHECK ("confidence" BETWEEN 0 AND 100);
ALTER TABLE "player_match_appearances" ADD CONSTRAINT "player_appearance_side_check" CHECK ("side" IN ('home', 'away'));
ALTER TABLE "bet_player_props" ADD CONSTRAINT "player_prop_revision_check" CHECK ("revision" > 0);
ALTER TABLE "bet_player_props" ADD CONSTRAINT "player_prop_state_check" CHECK ("resolutionStatus" IN ('PENDING', 'MATCHED', 'REVIEW'));
ALTER TABLE "bet_player_props" ADD CONSTRAINT "player_prop_terms_check" CHECK (
  jsonb_typeof("terms") = 'object' AND "terms"->>'version' = '1'
  AND "terms" ?& ARRAY['jogador', 'family', 'period', 'direction', 'lineQuarters', 'substituicao']
  AND "terms"->>'substituicao' IN ('PRESENT', 'ABSENT', 'UNKNOWN')
  AND jsonb_typeof("rule") = 'object' AND "rule" ?& ARRAY['version', 'bookmaker', 'family', 'verified']
  AND "rule"->>'family' = "terms"->>'family'
);

ALTER TABLE "telegram_media_albums" ADD COLUMN "photos" JSONB NOT NULL DEFAULT '[]';
