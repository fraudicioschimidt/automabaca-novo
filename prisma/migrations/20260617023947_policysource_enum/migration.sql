-- CreateEnum
CREATE TYPE "PolicySource" AS ENUM ('AUTO', 'MANUAL');

-- AlterTable: conversão IN-PLACE preservando os valores existentes (AUTO/MANUAL).
-- NÃO usar DROP+ADD (o default que o Prisma gerou) — isso resetaria toda
-- política source='MANUAL' (decisão humana) para 'AUTO' em produção, violando
-- o invariante "MANUAL nunca é sobrescrito pelo avaliador".
ALTER TABLE "market_segment_policies" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "market_segment_policies" ALTER COLUMN "source" TYPE "PolicySource" USING ("source"::"PolicySource");
ALTER TABLE "market_segment_policies" ALTER COLUMN "source" SET DEFAULT 'AUTO';
