-- @migration-manual: remove triggers de compatibilidade da release anterior (mortos)
-- Estes triggers só agem em conexão SEM `automabaca.writer_contract=v2` (ou,
-- no fechamento, sem `automabaca.price_contract=v1`). Toda release no ar desde
-- agosto declara as duas marcas no pool (`src/infra/prisma.ts`), então para o
-- código eles não fazem nada. Para escrita fora do pool (psql, script) eles
-- "consertavam" em silêncio o que os CHECKs deveriam recusar; sem eles, os
-- CHECKs de settledAt, confiança, autoScore e proveniência do fechamento
-- recusam de vez.
--
-- Ficam as invariantes que o código usa: imutabilidade das observações e do
-- contexto financeiro, versão de liquidação manual, travas de revogação de
-- alias, contadores do arquivo de preço e `automabaca_valid_price_reference_v1`
-- (usada pelos CHECKs de referência de preço).
BEGIN;

DROP TRIGGER IF EXISTS "bets_compat_writer_v1" ON "bets";
DROP FUNCTION IF EXISTS "automabaca_compat_bet_writer_v1"();

DROP TRIGGER IF EXISTS "team_aliases_compat_writer_v1" ON "team_aliases";
DROP TRIGGER IF EXISTS "team_provider_aliases_compat_writer_v1" ON "team_provider_aliases";
DROP FUNCTION IF EXISTS "automabaca_compat_alias_writer_v1"();

DROP TRIGGER IF EXISTS "bet_closing_compat_writer_v1" ON "bet_closing";
DROP FUNCTION IF EXISTS "automabaca_compat_closing_writer_v1"();

DROP TRIGGER IF EXISTS "bet_closing_compat_price_writer_v0" ON "bet_closing";
DROP FUNCTION IF EXISTS "automabaca_compat_closing_price_writer_v0"();

DROP TRIGGER IF EXISTS "training_cases_compat_writer_v1" ON "training_cases";
DROP FUNCTION IF EXISTS "automabaca_compat_training_writer_v1"();

COMMIT;
