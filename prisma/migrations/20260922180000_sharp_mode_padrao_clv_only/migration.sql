-- Banca nova passa a nascer em CLV_ONLY: o EV de entrada (modo FULL) saiu do
-- projeto em 22/09/2026. Só o valor padrão muda; as bancas existentes em FULL
-- são convertidas por `dist/ops-bancas-sem-ev.mjs`.
ALTER TABLE "bankrolls" ALTER COLUMN "sharpMode" SET DEFAULT 'CLV_ONLY';
