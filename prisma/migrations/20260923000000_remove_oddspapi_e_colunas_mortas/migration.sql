-- @migration-manual: apaga as tabelas da resposta com odds (OddsPapi, funcionalidade removida no #134) e colunas sem leitor
-- Conferido em produção em 22/09/2026: telegram_bot_posts 5 linhas e
-- telegram_reply_probes 11 (só dados da funcionalidade removida); as colunas
-- abaixo estão vazias em todas as linhas.

-- Resposta com odds no post do tipster (removida no #134)
ALTER TABLE "telegram_bot_posts" DROP CONSTRAINT "telegram_bot_posts_betId_fkey";
ALTER TABLE "telegram_reply_probes" DROP CONSTRAINT "telegram_reply_probes_betId_fkey";
DROP TABLE "telegram_bot_posts";
DROP TABLE "telegram_reply_probes";

-- Banca: exclusão é definitiva desde agosto (tombstone barrado por CHECK);
-- parserSlug e sharpModeDemotedAt não têm leitor.
ALTER TABLE "bankrolls" DROP CONSTRAINT IF EXISTS "bankrolls_deletedAt_legacy_only";
DROP INDEX "bankrolls_deletedAt_idx";
ALTER TABLE "bankrolls" DROP COLUMN "deletedAt",
DROP COLUMN "parserSlug",
DROP COLUMN "sharpModeDemotedAt";

-- Sem leitor nem tela
ALTER TABLE "contas" DROP COLUMN "observacoes";
ALTER TABLE "match_cache" DROP COLUMN "providerSportKey";
