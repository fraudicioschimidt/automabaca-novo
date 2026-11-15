BEGIN;

-- A resposta passa a sair mesmo sem preço da Pinnacle. Duas colunas de retrato:
-- a idade da odd ("⚠️Pinnacle há 40min") precisa ser recalculada a cada edição
-- da mensagem, e o casamento sem prova de id precisa aparecer na linha das casas.
ALTER TABLE "telegram_bot_posts"
  ADD COLUMN "pinnacleObservedAt" TIMESTAMPTZ(3),
  ADD COLUMN "matchedByName" BOOLEAN NOT NULL DEFAULT false;

-- Sem preço da Pinnacle a aposta volta ao revive a cada 30min–2h até o kickoff.
-- Sem este freio, cada volta gastaria duas requisições da OddsPapi.
CREATE TABLE "telegram_reply_probes" (
  "betId" TEXT PRIMARY KEY,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "telegram_reply_probes"
  ADD CONSTRAINT "telegram_reply_probes_betId_fkey"
  FOREIGN KEY ("betId") REFERENCES "bets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
