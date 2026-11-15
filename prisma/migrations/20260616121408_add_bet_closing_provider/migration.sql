-- Atribuição de provider no fechamento: qual provider forneceu a odd de
-- closing (distinto de "source" = mecanismo). Aditivo, nullable — seguro.
ALTER TABLE "bet_closing" ADD COLUMN "provider" TEXT;
