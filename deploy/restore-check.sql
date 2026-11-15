BEGIN READ ONLY;
DO $$
DECLARE required_table text;
BEGIN
  IF current_database() <> 'automabaca_novo_restorecheck' THEN
    RAISE EXCEPTION 'Refusing restoration checks outside the disposable database';
  END IF;
  FOREACH required_table IN ARRAY ARRAY['_prisma_migrations','bankrolls','bets','bet_sharp','bet_closing','contas','movimentacoes','settlement_events'] LOOP
    IF to_regclass('public.' || required_table) IS NULL THEN
      RAISE EXCEPTION 'Required table missing: %', required_table;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
     OR EXISTS (SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'Migration state is incomplete';
  END IF;
  IF EXISTS (SELECT 1 FROM bets WHERE status='PENDING' AND lucro<>0) THEN
    RAISE EXCEPTION 'Pending bet has a realized profit';
  END IF;
  IF EXISTS (SELECT 1 FROM contas c LEFT JOIN LATERAL
       (SELECT COALESCE(sum(valor),0) AS balance FROM movimentacoes m WHERE m."contaId"=c.id) m ON true
       WHERE c."saldoAtual" <> m.balance) THEN
    RAISE EXCEPTION 'Account and ledger balances disagree';
  END IF;
  IF EXISTS (SELECT 1 FROM bets WHERE "sourceExternalId" IS NOT NULL GROUP BY source,"sourceExternalId" HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Duplicate source identity';
  END IF;
  IF to_regclass('pgboss.job') IS NULL THEN
    RAISE EXCEPTION 'Durable queue missing';
  END IF;
END $$;
SELECT json_build_object('checks',json_build_array('full_restore','required_tables','migration_state','pending_profit','account_ledger','source_identity','durable_queues'),
  'counts',json_build_object('bets',(SELECT count(*) FROM bets),'bankrolls',(SELECT count(*) FROM bankrolls),
      'accounts',(SELECT count(*) FROM contas),'movements',(SELECT count(*) FROM movimentacoes)),
  'migrations',(SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL));
ROLLBACK;
