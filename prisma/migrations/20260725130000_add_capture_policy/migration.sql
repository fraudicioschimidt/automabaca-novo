-- Política de captura por banca: antes era heurística de slug no código
-- (`slug.includes("will")`), o que obrigava a editar o guard a cada canal novo.
CREATE TYPE "CapturePolicy" AS ENUM ('AUTO', 'CAPTION_ODD', 'IMAGE_ODD');

ALTER TABLE "bankrolls"
  ADD COLUMN "capturePolicy" "CapturePolicy" NOT NULL DEFAULT 'AUTO';

-- Preserva EXATAMENTE o comportamento que estava em produção: o único canal que
-- o código tratava como "odd da legenda manda" era o que tem `will` no slug.
-- Bancas de treino ficam em AUTO, que é a política pela legenda que elas já usavam.
UPDATE "bankrolls"
SET "capturePolicy" = 'CAPTION_ODD'
WHERE lower("slug") LIKE '%will%';
