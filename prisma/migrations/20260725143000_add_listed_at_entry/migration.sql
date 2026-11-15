-- O jogo já estava listado no provider quando a aposta entrou?
-- Responde de forma MEDIDA a pergunta que hoje o operador só descobre com
-- semanas de uso: este canal posta antes de a Pinnacle abrir a linha (então
-- CLV_ONLY é o modo correto) ou depois (então FULL calcula EV de verdade)?
ALTER TABLE "bet_sharp" ADD COLUMN "listedAtEntry" BOOLEAN;

-- Índice para a agregação por banca (percentual sobre amostra com o campo
-- preenchido). Parcial: linhas sem medição não interessam à consulta.
CREATE INDEX "bet_sharp_listedAtEntry_idx"
  ON "bet_sharp" ("listedAtEntry")
  WHERE "listedAtEntry" IS NOT NULL;
