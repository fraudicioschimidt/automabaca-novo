-- Primeira vez que o FlashScore olhou a aposta, gravada uma vez só: o casamento
-- do dia conta a aposta por ela. Fica na aposta porque a evidência em
-- bet_result é apagada pela correção, pelo Vincular e pela reabertura. Coluna
-- nova, vazia nas linhas existentes.
ALTER TABLE "bets" ADD COLUMN "flashscoreFirstCheckedAt" TIMESTAMPTZ(3);
