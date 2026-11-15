-- @migration-manual: apaga as colunas do EV de entrada e o modo FULL; o código anterior ainda as lê
-- Etapa 4 da remoção do EV (22/09/2026). O EV de entrada saiu do produto nas
-- etapas 1 a 3; aqui saem as colunas e o valor FULL do enum. A abertura mora
-- em `bet_opening` desde 20260922200000_bet_opening.
BEGIN;

-- Triggers de compatibilidade de escritores antigos e CHECKs do bet_sharp: todos
-- citam colunas que saem abaixo. Sem EV de entrada e sem abertura no bet_sharp,
-- não há preço nele para proteger; o `priceReference` fica só como ponteiro
-- do evento para o fechamento.
DROP TRIGGER IF EXISTS "bet_sharp_compat_writer_v1" ON "bet_sharp";
DROP FUNCTION IF EXISTS "automabaca_compat_sharp_writer_v1"();
DROP TRIGGER IF EXISTS "bet_sharp_compat_price_writer_v0" ON "bet_sharp";
DROP FUNCTION IF EXISTS "automabaca_compat_price_writer_v0"();
ALTER TABLE "bet_sharp" DROP CONSTRAINT IF EXISTS "bet_sharp_entry_metrics_require_listing_check";
ALTER TABLE "bet_sharp" DROP CONSTRAINT IF EXISTS "bet_sharp_price_provenance_check";

-- FULL sai do enum. As bancas já foram convertidas para CLV_ONLY na etapa 3;
-- o UPDATE só cobre alguma que tenha escapado. Intenção de arquivo de preço é
-- imutável (trigger de UPDATE) e a de FULL não tem mais uso: sai inteira.
UPDATE "bankrolls" SET "sharpMode" = 'CLV_ONLY' WHERE "sharpMode" = 'FULL';
DELETE FROM "price_archive_intents" WHERE "mode" = 'FULL';
ALTER TABLE "price_archive_intents" DROP CONSTRAINT IF EXISTS "price_archive_intents_mode_check";

CREATE TYPE "SharpMode_new" AS ENUM ('OFF', 'CLV_ONLY', 'IDENTITY_ONLY');
ALTER TABLE "bankrolls" ALTER COLUMN "sharpMode" DROP DEFAULT;
ALTER TABLE "bankrolls" ALTER COLUMN "sharpMode" TYPE "SharpMode_new" USING ("sharpMode"::text::"SharpMode_new");
ALTER TABLE "price_archive_intents" ALTER COLUMN "mode" TYPE "SharpMode_new" USING ("mode"::text::"SharpMode_new");
ALTER TYPE "SharpMode" RENAME TO "SharpMode_old";
ALTER TYPE "SharpMode_new" RENAME TO "SharpMode";
DROP TYPE "SharpMode_old";
ALTER TABLE "bankrolls" ALTER COLUMN "sharpMode" SET DEFAULT 'CLV_ONLY';

-- Arquivo de preço só existe para o fechamento das bancas CLV_ONLY.
ALTER TABLE "price_archive_intents"
  ADD CONSTRAINT "price_archive_intents_mode_check" CHECK ("mode" = 'CLV_ONLY');

ALTER TABLE "bet_sharp" DROP COLUMN "entryFairOdd",
DROP COLUMN "entryMaxBet",
DROP COLUMN "entryMaxBetCurrency",
DROP COLUMN "entryPriceObservedAt",
DROP COLUMN "entryPriceSnapshot",
DROP COLUMN "entryRawOdd",
DROP COLUMN "evAbertura",
DROP COLUMN "evEntrada",
DROP COLUMN "houseEdgeBps",
DROP COLUMN "listedAtEntry",
DROP COLUMN "openingMaxBet",
DROP COLUMN "openingMaxBetCurrency",
DROP COLUMN "openingOdd",
DROP COLUMN "openingPriceObservedAt",
DROP COLUMN "openingPriceSnapshot",
DROP COLUMN "openingRawOdd";

COMMIT;
