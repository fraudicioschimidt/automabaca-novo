-- Quando o dono marcou a entrada como pega (👍 no post do canal). Coluna nova,
-- vazia nas linhas existentes.
ALTER TABLE "bets" ADD COLUMN "takenAt" TIMESTAMPTZ(3);
