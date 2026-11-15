-- Início da amostra do segmento religado para novo teste: a avaliação conta só
-- o que fechou desde então, em qualquer fase. Coluna nova, vazia nas linhas
-- existentes.
ALTER TABLE "market_segment_policies" ADD COLUMN "sampleStartedAt" TIMESTAMPTZ(3);
