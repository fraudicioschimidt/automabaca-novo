-- Idempotência da movimentação manual (auditoria externa 003, achado 13).
--
-- Escrita à mão pelo mesmo motivo da migration irmã de 28/07: o `migrate dev`
-- arrasta drift pré-existente sem relação com esta mudança (tipo da PK em
-- telegram_dm_drafts, defaults de updatedAt em ia_judge_cooldowns e
-- telegram_media_albums). Aqui entra SÓ o que foi decidido.
--
-- O problema: `registrarMovimentacaoManual` inseria sem nenhuma barreira de
-- servidor. O guard da tela é `if (pend) return; setPend(true)` com estado
-- React — dois cliques no mesmo tick passam os dois e viram DOIS depósitos.
-- O drift-check não pega, porque `saldoAtual = Σ movimentações` continua
-- verdadeiro com as duas linhas: o extrato fica certo e o SALDO fica errado.
-- Era a única porta de escrita de dinheiro sem idempotência — o ledger de
-- settlement já tem a dele em `(betId, type, payloadHash)`.
--
-- Coluna nullable: as movimentações que nascem do settlement não têm chave e
-- não precisam (estorno-antes-de-lançar já as torna idempotentes). Nenhum
-- backfill, nenhuma linha existente viola o unique.
ALTER TABLE "movimentacoes" ADD COLUMN "clientMutationId" TEXT;

CREATE UNIQUE INDEX "movimentacoes_clientMutationId_key"
  ON "movimentacoes"("clientMutationId");
