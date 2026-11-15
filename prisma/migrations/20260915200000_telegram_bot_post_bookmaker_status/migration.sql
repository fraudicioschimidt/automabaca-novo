BEGIN;
ALTER TABLE "telegram_bot_posts"
  ADD COLUMN "bookmakerStatus" TEXT CHECK ("bookmakerStatus" IS NULL OR "bookmakerStatus" IN
    ('com_casas', 'sem_casas', 'jogo_nao_encontrado', 'mercado_nao_coberto', 'nao_conferiu', 'indisponivel'));
COMMIT;
