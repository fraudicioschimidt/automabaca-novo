-- Nomes de tipster na ficha do time: o nome que o tipster usou, aprendido
-- quando a identidade automática casou a aposta com um jogo ligado pelo
-- pareamento dos catálogos. `pending` na primeira vez; `confirmed` quando o
-- mesmo nome volta, na mesma ficha, noutro evento, noutra aposta e noutro dia
-- de São Paulo.
CREATE TABLE "team_tipster_names" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameNorm" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "firstBetId" TEXT NOT NULL,
    "firstPinnacleEventId" TEXT NOT NULL,
    "firstDay" TEXT NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3),
    "confirmedByBetId" TEXT,
    "decidedBy" TEXT NOT NULL DEFAULT 'auto',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_tipster_names_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "team_tipster_names_status_check" CHECK ("status" IN ('pending', 'confirmed'))
);

CREATE UNIQUE INDEX "team_tipster_names_cardId_nameNorm_key" ON "team_tipster_names"("cardId", "nameNorm");

CREATE INDEX "team_tipster_names_sport_nameNorm_idx" ON "team_tipster_names"("sport", "nameNorm");

-- Uma ficha por nome confirmado no mesmo esporte, país e categoria: a tradução
-- nunca tem duas respostas para o mesmo nome confirmado no mesmo contexto.
CREATE UNIQUE INDEX "team_tipster_names_confirmed_scope_name_uidx"
    ON "team_tipster_names"("sport", "country", "category", "nameNorm")
    WHERE "status" = 'confirmed';

ALTER TABLE "team_tipster_names" ADD CONSTRAINT "team_tipster_names_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "team_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A aposta de identidade automática cujo jogo ainda não estava ligado: o nome
-- do tipster espera a rodada do pareamento que ligar o jogo.
CREATE TABLE "team_tipster_name_waits" (
    "id" TEXT NOT NULL,
    "betId" TEXT NOT NULL,
    "pinnacleEventId" TEXT NOT NULL,
    "tipsterHome" TEXT NOT NULL,
    "tipsterAway" TEXT NOT NULL,
    "pinnacleHome" TEXT NOT NULL,
    "pinnacleAway" TEXT NOT NULL,
    "kickoff" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_tipster_name_waits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "team_tipster_name_waits_betId_key" ON "team_tipster_name_waits"("betId");

CREATE INDEX "team_tipster_name_waits_pinnacleEventId_idx" ON "team_tipster_name_waits"("pinnacleEventId");

CREATE INDEX "team_tipster_name_waits_kickoff_idx" ON "team_tipster_name_waits"("kickoff");
