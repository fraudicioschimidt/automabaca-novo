BEGIN;

-- A Pinnacle some do pacote da OddsPapi em parte das partidas (medido em
-- 16/09 no Deportivo x Sevilla: nenhuma linha de cartões da Pinnacle, contra 92
-- casas com preço ativo). Sem ela não há o que conferir, e a resposta ficava
-- muda mesmo tendo o jogo casado por id e o nosso próprio preço sharp.
-- A linha passa a sair marcada; a coluna guarda a marca para as edições.
ALTER TABLE "telegram_bot_posts"
  ADD COLUMN "semConferencia" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
