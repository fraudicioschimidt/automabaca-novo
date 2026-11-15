ALTER TABLE "movimentacoes"
ADD COLUMN "actor" TEXT NOT NULL DEFAULT 'system';

CREATE INDEX "movimentacoes_actor_createdAt_idx"
ON "movimentacoes"("actor", "createdAt");
