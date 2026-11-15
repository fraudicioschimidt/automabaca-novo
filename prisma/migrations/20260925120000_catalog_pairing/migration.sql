-- Pareamento diário dos catálogos (`teams.catalog_pairing`): o jogo da
-- Pinnacle17 ligado ao do FlashScore e a ficha do time (id do FlashScore com
-- os nomes da Pinnacle17). Tabelas novas, só gravadas: nada no fluxo de apostas
-- as lê.
CREATE TABLE "catalog_game_links" (
    "id" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "pinnacleEventId" TEXT NOT NULL,
    "flashscoreMatchId" TEXT NOT NULL,
    "kickoffPinnacle" TIMESTAMPTZ(3) NOT NULL,
    "kickoffFlashscore" TIMESTAMPTZ(3) NOT NULL,
    "pinnacleHome" TEXT NOT NULL,
    "pinnacleAway" TEXT NOT NULL,
    "pinnacleLeague" TEXT NOT NULL,
    "pinnacleCountry" TEXT NOT NULL DEFAULT '',
    "flashscoreHome" TEXT NOT NULL,
    "flashscoreAway" TEXT NOT NULL,
    "flashscoreTournament" TEXT NOT NULL DEFAULT '',
    "flashscoreCountry" TEXT NOT NULL DEFAULT '',
    "flashscoreHomeTeamId" TEXT NOT NULL,
    "flashscoreAwayTeamId" TEXT NOT NULL,
    "swapped" BOOLEAN NOT NULL,
    "score" DECIMAL(5,4) NOT NULL,
    "decidedBy" TEXT NOT NULL DEFAULT 'catalog',
    "status" TEXT NOT NULL DEFAULT 'ok',
    "conflictFlashscoreMatchId" TEXT,
    "moved" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastPairedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "catalog_game_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "catalog_game_links_score_check" CHECK ("score" >= 0 AND "score" <= 2)
);

CREATE TABLE "team_cards" (
    "id" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "flashscoreTeamId" TEXT NOT NULL,
    "flashscoreName" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "team_cards_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "team_card_evidence" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "pinnacleEventId" TEXT NOT NULL,
    "pinnacleName" TEXT NOT NULL,
    "nameNorm" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "leagueKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_card_evidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "catalog_game_links_pinnacleEventId_key" ON "catalog_game_links"("pinnacleEventId");

CREATE INDEX "catalog_game_links_flashscoreMatchId_idx" ON "catalog_game_links"("flashscoreMatchId");

CREATE INDEX "catalog_game_links_kickoffPinnacle_idx" ON "catalog_game_links"("kickoffPinnacle");

CREATE UNIQUE INDEX "team_cards_sport_flashscoreTeamId_key" ON "team_cards"("sport", "flashscoreTeamId");

CREATE UNIQUE INDEX "team_card_evidence_cardId_pinnacleEventId_key" ON "team_card_evidence"("cardId", "pinnacleEventId");

ALTER TABLE "team_card_evidence" ADD CONSTRAINT "team_card_evidence_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "team_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
