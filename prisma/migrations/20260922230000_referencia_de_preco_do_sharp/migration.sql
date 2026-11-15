-- @migration-manual: ADD CHECK sem shim de escritor; a régua do deploy recusa por princípio
-- Repõe, na medida certa, a invariante que a remoção do EV levou junto.
--
-- Até 22/09/2026 o `bet_sharp_price_provenance_check` validava o formato do
-- `priceReference` como parte da prova do PREÇO de entrada/abertura. Sem essas
-- colunas, o CHECK inteiro saiu — e o `priceReference` ficou sem nenhuma
-- validação, apesar de continuar sendo o ponteiro que o fechamento reabre para
-- pedir preço. Referência torta aqui vira fechamento pedido no evento errado.
--
-- O código no ar não consegue violar: só `upsertSharp` escreve, e a referência
-- vem sempre dos codificadores tipados (`encodeBridgePriceReference` /
-- `encodePinnacle17PriceReference`). Isto fecha a porta para escrita fora do
-- fluxo — psql à mão, script de ops, mudança futura.
ALTER TABLE "bet_sharp"
  ADD CONSTRAINT "bet_sharp_price_reference_check" CHECK (
    "priceReference" IS NULL
    OR (provider IS NOT NULL AND "automabaca_valid_price_reference_v1"(provider, "priceReference"))
  );
