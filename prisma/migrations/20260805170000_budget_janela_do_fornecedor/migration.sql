-- Janela de cota do FORNECEDOR ao lado do nosso guarda-corpo.
--
-- A `periodKey` do flashscore é o dia de São Paulo (vira 03:00 UTC); a janela do
-- RapidAPI virava ~15:33 UTC. Medido em 05/08/2026: com o contador reconciliado
-- em 1000 e o cap em 900, TODA chamada era recusada por nós — e como nenhuma
-- passava, nunca líamos o header que provaria que o fornecedor já tinha
-- liberado. Onze horas e meia de liquidação parada por bloqueio nosso.
--
-- Null continua sendo o normal para provider que não publica janela.
ALTER TABLE "provider_budgets" ADD COLUMN "windowResetAt" TIMESTAMPTZ(3);
