-- Sinal "ao vivo" da legenda, gravado na aposta: a evidência de captura expira
-- em 30 dias e a liquidação não pode depender dela.
ALTER TABLE "bets" ADD COLUMN "liveTextAtCapture" BOOLEAN NOT NULL DEFAULT false;
