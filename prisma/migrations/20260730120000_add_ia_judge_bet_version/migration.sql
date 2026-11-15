-- Sugestões novas carregam a versão exata da aposta usada no prompt.
-- Nullable preserva sugestões históricas que não tinham esse snapshot.
ALTER TABLE "ia_judge_suggestions"
  ADD COLUMN "betUpdatedAt" TIMESTAMPTZ(3);
