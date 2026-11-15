-- CreateEnum
CREATE TYPE "BetStatus" AS ENUM ('PENDING', 'WON', 'LOST', 'VOID', 'HALF_WON', 'HALF_LOST', 'CASHOUT', 'CANCELED');

-- CreateEnum
CREATE TYPE "SharpMode" AS ENUM ('OFF', 'FULL', 'CLV_ONLY');

-- CreateEnum
CREATE TYPE "IdentityStatus" AS ENUM ('PENDING', 'MATCHED', 'UNMATCHED', 'UNSUPPORTED', 'MANUAL');

-- CreateEnum
CREATE TYPE "ClosingSource" AS ENUM ('CRON', 'MANUAL', 'REPROCESS');

-- CreateEnum
CREATE TYPE "ContaStatus" AS ENUM ('ATIVA', 'LIMITADA', 'ENCERRADA');

-- CreateEnum
CREATE TYPE "MovimentacaoTipo" AS ENUM ('DEPOSITO', 'SAQUE', 'GANHO_APOSTA', 'PERDA_APOSTA', 'BONUS', 'AJUSTE_MANUAL', 'ESTORNO');

-- CreateEnum
CREATE TYPE "AliasSource" AS ENUM ('AUTO', 'LLM', 'MANUAL');

-- CreateEnum
CREATE TYPE "TrainingStatus" AS ENUM ('OPEN', 'AUTO_APPLIED', 'LLM_APPLIED', 'RESOLVED_MANUAL', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "bankrolls" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "capitalInicial" DECIMAL(12,2) NOT NULL DEFAULT 100,
    "valorUnidade" DECIMAL(10,2) NOT NULL DEFAULT 20,
    "sharpMode" "SharpMode" NOT NULL DEFAULT 'FULL',
    "vincularContas" BOOLEAN NOT NULL DEFAULT true,
    "telegramChannelId" BIGINT,
    "defaultBookmaker" TEXT,
    "parserSlug" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "bankrolls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bets" (
    "id" TEXT NOT NULL,
    "bankrollId" TEXT NOT NULL,
    "data" TIMESTAMPTZ(3) NOT NULL,
    "evento" TEXT NOT NULL,
    "esporte" TEXT NOT NULL,
    "competicao" TEXT NOT NULL DEFAULT '',
    "pais" TEXT NOT NULL DEFAULT '',
    "casaDeAposta" TEXT NOT NULL DEFAULT '',
    "tipster" TEXT NOT NULL DEFAULT '',
    "mercado" TEXT NOT NULL,
    "selecao" TEXT NOT NULL,
    "odds" DECIMAL(10,4) NOT NULL,
    "stake" DECIMAL(14,6) NOT NULL,
    "status" "BetStatus" NOT NULL DEFAULT 'PENDING',
    "lucro" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "legsJson" JSONB,
    "source" TEXT NOT NULL DEFAULT 'web',
    "sourceExternalId" TEXT,
    "contaId" TEXT,
    "registradoEm" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bet_sharp" (
    "betId" TEXT NOT NULL,
    "identityStatus" "IdentityStatus" NOT NULL DEFAULT 'PENDING',
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "providerMatchId" TEXT,
    "openingOdd" DECIMAL(10,4),
    "openingRawOdd" DECIMAL(10,4),
    "entryFairOdd" DECIMAL(10,4),
    "evEntrada" DECIMAL(8,4),
    "evAbertura" DECIMAL(8,4),
    "houseEdgeBps" INTEGER,
    "openingMaxBet" INTEGER,
    "entryMaxBet" INTEGER,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bet_sharp_pkey" PRIMARY KEY ("betId")
);

-- CreateTable
CREATE TABLE "bet_closing" (
    "betId" TEXT NOT NULL,
    "closingOdd" DECIMAL(10,4),
    "closingRawOdd" DECIMAL(10,4),
    "clv" DECIMAL(8,4),
    "clvReliable" BOOLEAN,
    "closingMaxBet" INTEGER,
    "scoreHome" INTEGER,
    "scoreAway" INTEGER,
    "source" "ClosingSource",
    "fetchedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bet_closing_pkey" PRIMARY KEY ("betId")
);

-- CreateTable
CREATE TABLE "contas" (
    "id" TEXT NOT NULL,
    "casaDeAposta" TEXT NOT NULL,
    "titular" TEXT NOT NULL,
    "apelido" TEXT,
    "saldoInicial" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "saldoAtual" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "ContaStatus" NOT NULL DEFAULT 'ATIVA',
    "observacoes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "contas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contas_bankrolls" (
    "contaId" TEXT NOT NULL,
    "bankrollId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contas_bankrolls_pkey" PRIMARY KEY ("contaId","bankrollId")
);

-- CreateTable
CREATE TABLE "movimentacoes" (
    "id" TEXT NOT NULL,
    "contaId" TEXT NOT NULL,
    "tipo" "MovimentacaoTipo" NOT NULL,
    "valor" DECIMAL(12,2) NOT NULL,
    "saldoApos" DECIMAL(12,2) NOT NULL,
    "descricao" TEXT,
    "betId" TEXT,
    "data" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "movimentacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mercados_padrao" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "mercados_padrao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mercados_alias" (
    "id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "aliasNormalizado" TEXT NOT NULL,
    "casaDeAposta" TEXT NOT NULL DEFAULT '',
    "mercadoPadraoId" TEXT NOT NULL,

    CONSTRAINT "mercados_alias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_aliases" (
    "id" TEXT NOT NULL,
    "localNorm" TEXT NOT NULL,
    "pinnacleName" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "pais" TEXT NOT NULL DEFAULT '',
    "competitionNorm" TEXT NOT NULL DEFAULT '',
    "competitionName" TEXT,
    "source" "AliasSource" NOT NULL DEFAULT 'AUTO',
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_cache" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "localHomeNorm" TEXT NOT NULL,
    "localAwayNorm" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "pais" TEXT NOT NULL DEFAULT '',
    "competitionNorm" TEXT NOT NULL DEFAULT '',
    "competitionName" TEXT,
    "matchDateKey" TEXT NOT NULL,
    "pinnacleHome" TEXT NOT NULL,
    "pinnacleAway" TEXT NOT NULL,
    "providerMatchId" TEXT,
    "providerSportKey" TEXT,
    "matchDate" TIMESTAMPTZ(3),
    "source" "AliasSource" NOT NULL DEFAULT 'AUTO',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_cases" (
    "id" TEXT NOT NULL,
    "betId" TEXT,
    "status" "TrainingStatus" NOT NULL DEFAULT 'OPEN',
    "evento" TEXT NOT NULL,
    "esporte" TEXT NOT NULL,
    "pais" TEXT NOT NULL DEFAULT '',
    "competicao" TEXT NOT NULL DEFAULT '',
    "candidatesJson" JSONB,
    "autoScore" INTEGER NOT NULL DEFAULT 0,
    "llmVerdictJson" JSONB,
    "resolution" "AliasSource",
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "training_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_events" (
    "id" TEXT NOT NULL,
    "betId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "action" TEXT NOT NULL,
    "resource" TEXT,
    "resourceId" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'success',
    "details" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_budgets" (
    "provider" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "spent" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_budgets_pkey" PRIMARY KEY ("provider","periodKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "bankrolls_slug_key" ON "bankrolls"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "bankrolls_telegramChannelId_key" ON "bankrolls"("telegramChannelId");

-- CreateIndex
CREATE INDEX "bankrolls_deletedAt_idx" ON "bankrolls"("deletedAt");

-- CreateIndex
CREATE INDEX "bets_bankrollId_data_idx" ON "bets"("bankrollId", "data");

-- CreateIndex
CREATE INDEX "bets_bankrollId_status_data_idx" ON "bets"("bankrollId", "status", "data");

-- CreateIndex
CREATE INDEX "bets_bankrollId_registradoEm_idx" ON "bets"("bankrollId", "registradoEm");

-- CreateIndex
CREATE INDEX "bets_status_data_idx" ON "bets"("status", "data");

-- CreateIndex
CREATE INDEX "bets_bankrollId_tipster_idx" ON "bets"("bankrollId", "tipster");

-- CreateIndex
CREATE INDEX "bets_contaId_idx" ON "bets"("contaId");

-- CreateIndex
CREATE UNIQUE INDEX "bets_source_sourceExternalId_key" ON "bets"("source", "sourceExternalId");

-- CreateIndex
CREATE INDEX "bet_sharp_identityStatus_idx" ON "bet_sharp"("identityStatus");

-- CreateIndex
CREATE INDEX "contas_status_idx" ON "contas"("status");

-- CreateIndex
CREATE INDEX "contas_titular_idx" ON "contas"("titular");

-- CreateIndex
CREATE INDEX "contas_deletedAt_idx" ON "contas"("deletedAt");

-- CreateIndex
CREATE INDEX "contas_bankrolls_bankrollId_idx" ON "contas_bankrolls"("bankrollId");

-- CreateIndex
CREATE INDEX "movimentacoes_contaId_data_idx" ON "movimentacoes"("contaId", "data" DESC);

-- CreateIndex
CREATE INDEX "movimentacoes_contaId_tipo_idx" ON "movimentacoes"("contaId", "tipo");

-- CreateIndex
CREATE INDEX "movimentacoes_betId_idx" ON "movimentacoes"("betId");

-- CreateIndex
CREATE UNIQUE INDEX "mercados_padrao_nome_key" ON "mercados_padrao"("nome");

-- CreateIndex
CREATE INDEX "mercados_alias_aliasNormalizado_idx" ON "mercados_alias"("aliasNormalizado");

-- CreateIndex
CREATE UNIQUE INDEX "mercados_alias_aliasNormalizado_casaDeAposta_mercadoPadraoI_key" ON "mercados_alias"("aliasNormalizado", "casaDeAposta", "mercadoPadraoId");

-- CreateIndex
CREATE INDEX "team_aliases_localNorm_sport_idx" ON "team_aliases"("localNorm", "sport");

-- CreateIndex
CREATE INDEX "team_aliases_source_idx" ON "team_aliases"("source");

-- CreateIndex
CREATE UNIQUE INDEX "team_aliases_localNorm_sport_pais_competitionNorm_key" ON "team_aliases"("localNorm", "sport", "pais", "competitionNorm");

-- CreateIndex
CREATE INDEX "match_cache_localHomeNorm_localAwayNorm_sport_matchDateKey_idx" ON "match_cache"("localHomeNorm", "localAwayNorm", "sport", "matchDateKey");

-- CreateIndex
CREATE UNIQUE INDEX "match_cache_provider_localHomeNorm_localAwayNorm_sport_matc_key" ON "match_cache"("provider", "localHomeNorm", "localAwayNorm", "sport", "matchDateKey", "pais", "competitionNorm");

-- CreateIndex
CREATE INDEX "training_cases_status_createdAt_idx" ON "training_cases"("status", "createdAt");

-- CreateIndex
CREATE INDEX "training_cases_betId_idx" ON "training_cases"("betId");

-- CreateIndex
CREATE INDEX "settlement_events_betId_createdAt_idx" ON "settlement_events"("betId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_events_betId_type_payloadHash_key" ON "settlement_events"("betId", "type", "payloadHash");

-- CreateIndex
CREATE INDEX "audit_events_action_createdAt_idx" ON "audit_events"("action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_createdAt_idx" ON "audit_events"("createdAt");

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_bankrollId_fkey" FOREIGN KEY ("bankrollId") REFERENCES "bankrolls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_contaId_fkey" FOREIGN KEY ("contaId") REFERENCES "contas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bet_sharp" ADD CONSTRAINT "bet_sharp_betId_fkey" FOREIGN KEY ("betId") REFERENCES "bets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bet_closing" ADD CONSTRAINT "bet_closing_betId_fkey" FOREIGN KEY ("betId") REFERENCES "bets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contas_bankrolls" ADD CONSTRAINT "contas_bankrolls_contaId_fkey" FOREIGN KEY ("contaId") REFERENCES "contas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contas_bankrolls" ADD CONSTRAINT "contas_bankrolls_bankrollId_fkey" FOREIGN KEY ("bankrollId") REFERENCES "bankrolls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimentacoes" ADD CONSTRAINT "movimentacoes_contaId_fkey" FOREIGN KEY ("contaId") REFERENCES "contas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimentacoes" ADD CONSTRAINT "movimentacoes_betId_fkey" FOREIGN KEY ("betId") REFERENCES "bets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mercados_alias" ADD CONSTRAINT "mercados_alias_mercadoPadraoId_fkey" FOREIGN KEY ("mercadoPadraoId") REFERENCES "mercados_padrao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_cases" ADD CONSTRAINT "training_cases_betId_fkey" FOREIGN KEY ("betId") REFERENCES "bets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_events" ADD CONSTRAINT "settlement_events_betId_fkey" FOREIGN KEY ("betId") REFERENCES "bets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
