-- @migration-manual: apaga as tabelas do replay e da coleta pendente do arquivo de preços, substituídos pela série de fechamento
-- Nenhum código lê ou grava estas tabelas desde a etapa 1. Em produção, em
-- 23/09/2026: coleta pendente e orçamento com 0 linhas (nunca gravaram);
-- intenções com 4 linhas gravadas pela release anterior à etapa 1, sem uso.

DROP TABLE "price_archive_collections";
DROP FUNCTION price_archive_collection_immutable();
DROP TABLE "price_archive_collection_budgets";
DROP TABLE "price_archive_intents";

-- Contador e imutabilidade passam a cuidar só das respostas guardadas.
CREATE OR REPLACE FUNCTION price_archive_count_rows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE price_archive_usage SET bytes = bytes + NEW."payloadBytes", observations = observations + 1 WHERE id = 1;
  ELSE
    UPDATE price_archive_usage SET bytes = bytes - OLD."payloadBytes", observations = observations - 1 WHERE id = 1;
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION price_archive_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'price archive evidence is immutable';
END $$;
ALTER TABLE "price_archive_usage" DROP COLUMN "intents";
