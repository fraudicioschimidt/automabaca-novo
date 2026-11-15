-- Instante da última troca do modo de medição da banca: a resposta de preço
-- guardada antes dela não vale para o fechamento. Coluna nova, vazia nas
-- linhas existentes.
ALTER TABLE "bankrolls" ADD COLUMN "sharpModeChangedAt" TIMESTAMPTZ(3);
