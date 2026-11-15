-- Endurecimento de schema vindo da auditoria externa 003 (achados 26, 28, 29, 30, 31).
-- Escrita à mão: o `migrate dev` arrastava drift pré-existente sem relação com
-- estes achados (troca de tipo de PK em telegram_dm_drafts, defaults de
-- updatedAt). Aqui entra SÓ o que foi decidido, e cada item foi verificado
-- contra a produção antes: zero linhas violam qualquer uma das constraints.

-- (26) O CHECK financeiro só guardava PENDING. `lucro.ts` manda VOID/CANCELED
-- para zero, mas nada impedia persistir `status='CANCELED', lucro=5` — uma linha
-- assim polui ROI e CLV em silêncio, e o consistency-check só percebe depois.
--
-- A auditoria propunha uma segunda metade ("status terminal exige settledAt").
-- Ela ficou de fora: ao aplicá-la, 53 testes de banco reprovaram porque suas
-- fixtures criam apostas terminais sem settledAt. Isso não é sujeira de teste —
-- é a prova de que esse invariante nunca existiu neste sistema. Gravá-lo no
-- banco seria inventar regra nova disfarçada de proteção, e quebraria qualquer
-- caminho de importação/correção que ainda não preenche o campo.
ALTER TABLE "bets" ADD CONSTRAINT "bets_terminal_lucro_zero"
  CHECK ("status" NOT IN ('VOID', 'CANCELED') OR "lucro" = 0);

-- (29) Único confidence do sistema que não é Int 0-100, e vem de LLM. O Zod da
-- borda já valida; esta é a segunda barreira que a lei 5 pede.
ALTER TABLE "ia_judge_suggestions" ADD CONSTRAINT "ia_judge_confidence_range"
  CHECK ("confidence" >= 0 AND "confidence" <= 1);

-- (31) O debounce de álbum depende de `status` ser exatamente open/done: um typo
-- persistia e a linha ficava invisível ao `WHERE status='open'`, vazando o
-- debounce para sempre.
ALTER TABLE "telegram_media_albums" ADD CONSTRAINT "telegram_media_albums_status_check"
  CHECK ("status" IN ('open', 'done'));

-- (30) O ledger é a prova do invariante `saldoAtual = Σ movimentações`. Cascade
-- deixava um hard-delete de conta apagá-lo junto, em silêncio. O irmão `betId` já
-- era Restrict.
ALTER TABLE "movimentacoes" DROP CONSTRAINT "movimentacoes_contaId_fkey";
ALTER TABLE "movimentacoes" ADD CONSTRAINT "movimentacoes_contaId_fkey"
  FOREIGN KEY ("contaId") REFERENCES "contas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- (28) Os probes de idempotência filtram `action` PRIMEIRO, às vezes sem
-- resourceId; o índice existente começa em `resource`.
CREATE INDEX "audit_events_action_resource_resourceId_idx"
  ON "audit_events"("action", "resource", "resourceId");
