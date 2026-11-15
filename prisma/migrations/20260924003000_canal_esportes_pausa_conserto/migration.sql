-- Esportes do canal marcados pelo dono (vazio = "vários/não sei") e a nova
-- fonte de confirmação do esporte por eles.
ALTER TYPE "SportResolutionSource" ADD VALUE 'CHANNEL' BEFORE 'UNRESOLVED';
ALTER TABLE "bankrolls" ADD COLUMN "channelSports" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Captura do canal pausada pelo dono.
ALTER TABLE "bankrolls" ADD COLUMN "capturePausedAt" TIMESTAMPTZ(3);

-- Conserto pela DM de uma captura recusada.
ALTER TABLE "telegram_dm_drafts" ADD COLUMN "captureFix" JSONB;
