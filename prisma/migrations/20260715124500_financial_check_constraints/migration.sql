ALTER TABLE "bankrolls"
  ADD CONSTRAINT "bankrolls_valor_unidade_positive"
    CHECK ("valorUnidade" > 0) NOT VALID,
  ADD CONSTRAINT "bankrolls_capital_inicial_nonnegative"
    CHECK ("capitalInicial" >= 0) NOT VALID;

ALTER TABLE "bets"
  ADD CONSTRAINT "bets_odds_plausible"
    CHECK (odds > 1 AND odds <= 1000) NOT VALID,
  ADD CONSTRAINT "bets_stake_plausible"
    CHECK (stake > 0 AND stake <= 1000) NOT VALID,
  ADD CONSTRAINT "bets_valor_unidade_positive"
    CHECK ("valorUnidade" > 0) NOT VALID,
  ADD CONSTRAINT "bets_pending_financial_state"
    CHECK (status <> 'PENDING' OR (lucro = 0 AND "settledAt" IS NULL)) NOT VALID;

ALTER TABLE "bankrolls"
  VALIDATE CONSTRAINT "bankrolls_valor_unidade_positive",
  VALIDATE CONSTRAINT "bankrolls_capital_inicial_nonnegative";

ALTER TABLE "bets"
  VALIDATE CONSTRAINT "bets_odds_plausible",
  VALIDATE CONSTRAINT "bets_stake_plausible",
  VALIDATE CONSTRAINT "bets_valor_unidade_positive",
  VALIDATE CONSTRAINT "bets_pending_financial_state";
