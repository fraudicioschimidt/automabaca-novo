import { MANUAL_MOVEMENT_TYPES, MAX_ACCOUNT_BALANCE, isManualMovementId } from "@/src/domain/account-policy";
import { type ContaStatus, type MovimentacaoTipo, Prisma } from "@/src/generated/prisma/client";
import { LEDGER_MIN_AMOUNT, roundMoney, toNumber } from "@/src/domain/money";
import { prepareCreationRequest, findCreationReceiptTx, recordCreationReceiptTx } from "@/src/services/shared/creation-receipt";
import { createLogger } from "@/src/infra/logger";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";
import {
  type SerializableTransactionClient,
  runSerializableTransaction,
} from "@/src/services/shared/transaction";

/**
 * Gestão de contas (multi-titular): criação, edição, ciclo de status e
 * movimentação manual. Entrada inválida é recusa de negócio, não falha: a
 * regra funcionando não pode derrubar a SLO da ação.
 */

const MAX_CASA_LENGTH = 100;
const MAX_TITULAR_LENGTH = 160;
const MAX_APELIDO_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;
const log = createLogger("contas");

function limitedText(value: string | undefined, label: string, max: number): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length > max) {
    throw new RecusaDeNegocioError(`${label} excede ${max} caracteres.`);
  }
  return normalized;
}

/**
 * Vínculo conta↔banca só aponta para banca existente. Na edição roda ANTES do
 * deleteMany, então lista ruim não destrói vínculo bom.
 */
async function assertBankrollsVinculaveis(
  tx: Prisma.TransactionClient,
  bankrollIds: string[] | undefined,
): Promise<void> {
  if (!bankrollIds?.length) return;
  const vivas = await tx.bankroll.findMany({
    where: { id: { in: bankrollIds } },
    select: { id: true },
  });
  if (vivas.length === bankrollIds.length) return;
  const encontradas = new Set(vivas.map((b) => b.id));
  const invalidas = bankrollIds.filter((id) => !encontradas.has(id));
  throw new RecusaDeNegocioError(
    `Tipster inexistente ou removido no vínculo da conta: ${invalidas.join(", ")}.`,
  );
}

export async function criarConta(
  params: {
    casaDeAposta: string;
    titular: string;
    apelido?: string;
    saldoInicial: number;
    requestId?: string;
    bankrollIds?: string[];
    actor?: string;
  },
  options?: { client?: SerializableTransactionClient },
): Promise<{ contaId: string }> {
  const casa = limitedText(params.casaDeAposta, "Casa", MAX_CASA_LENGTH);
  const titular = limitedText(params.titular, "Titular", MAX_TITULAR_LENGTH);
  const apelido = limitedText(params.apelido, "Apelido", MAX_APELIDO_LENGTH);
  if (!casa || !titular) throw new RecusaDeNegocioError("Casa e titular são obrigatórios.");
  if (!Number.isFinite(params.saldoInicial) || params.saldoInicial < 0 || params.saldoInicial > MAX_ACCOUNT_BALANCE) {
    throw new RecusaDeNegocioError("Saldo inicial inválido.");
  }
  // Mesmo guard de `registrarMovimentacaoManual` — evita drift Decimal(12,2).
  const saldoInicial = roundMoney(params.saldoInicial, 2);
  const actor = params.actor?.trim() || "system";
  const bankrollIds = params.bankrollIds ? [...new Set(params.bankrollIds)] : undefined;
  const request = prepareCreationRequest("conta.create", actor, params.requestId, {
    casa, titular, apelido: apelido || null, saldoInicial, bankrollIds: [...(bankrollIds ?? [])].sort(),
  });

  return runSerializableTransaction(
    "criarConta",
    async (tx) => {
      const existingId = await findCreationReceiptTx(tx, request);
      if (existingId) {
        const existing = await tx.conta.findUnique({ where: { id: existingId }, select: { id: true, deletedAt: true } });
        if (!existing || existing.deletedAt) throw new RecusaDeNegocioError("Esta criação já foi concluída e a conta foi removida. Abra um novo formulário.");
        return { contaId: existing.id };
      }
      await assertBankrollsVinculaveis(tx, bankrollIds);
      const conta = await tx.conta.create({
        data: {
          casaDeAposta: casa,
          titular,
          apelido: apelido || null,
          saldoInicial,
          saldoAtual: saldoInicial,
          bankrollLinks: bankrollIds?.length
            ? { create: bankrollIds.map((bankrollId) => ({ bankrollId })) }
            : undefined,
        },
        select: { id: true },
      });
      if (saldoInicial >= LEDGER_MIN_AMOUNT) {
        await tx.movimentacao.create({
          data: {
            contaId: conta.id,
            tipo: "DEPOSITO",
            valor: saldoInicial,
            saldoApos: saldoInicial,
            descricao: "Saldo inicial",
            actor,
          },
        });
      }
      await tx.auditEvent.create({
        data: {
          actor,
          action: "conta.create",
          resource: "conta",
          resourceId: conta.id,
          details: { casaDeAposta: casa, titular, saldoInicial },
        },
      });
      await recordCreationReceiptTx(tx, request, conta.id);
      return { contaId: conta.id };
    },
    options,
  );
}

/**
 * Edita metadados da conta (casa, titular, apelido, vínculos de bankroll).
 * NÃO toca em saldo/ledger — só atributos e os links ContaBankroll.
 * Casa e titular formam a identidade financeira: depois da primeira linha do
 * ledger só apelido e vínculos permanecem mutáveis.
 */
export async function editarConta(
  params: {
    contaId: string;
    casaDeAposta: string;
    titular: string;
    apelido?: string;
    bankrollIds?: string[];
    actor?: string;
  },
  options?: { client?: SerializableTransactionClient },
): Promise<void> {
  const casa = limitedText(params.casaDeAposta, "Casa", MAX_CASA_LENGTH);
  const titular = limitedText(params.titular, "Titular", MAX_TITULAR_LENGTH);
  const apelido = limitedText(params.apelido, "Apelido", MAX_APELIDO_LENGTH);
  const actor = params.actor?.trim() || "system";
  const bankrollIds = params.bankrollIds ? [...new Set(params.bankrollIds)] : undefined;
  if (!casa || !titular) throw new RecusaDeNegocioError("Casa e titular são obrigatórios.");

  await runSerializableTransaction(
    "editarConta",
    async (tx) => {
      const conta = await tx.conta.findFirst({
        where: { id: params.contaId, deletedAt: null },
        select: {
          id: true,
          casaDeAposta: true,
          titular: true,
          _count: { select: { movimentacoes: true } },
        },
      });
      if (!conta) {
        throw new RecusaDeNegocioError(`Conta ${params.contaId} inexistente ou removida.`);
      }
      const identidadeMudou =
        conta.casaDeAposta !== casa || conta.titular !== titular;
      if (identidadeMudou && conta._count.movimentacoes > 0) {
        throw new RecusaDeNegocioError(
          "A identidade financeira (casa e titular) é imutável depois do primeiro movimento. Crie outra conta para outra identidade.",
        );
      }
      await assertBankrollsVinculaveis(tx, bankrollIds);
      await tx.conta.update({
        where: { id: params.contaId },
        data: { casaDeAposta: casa, titular, apelido: apelido || null },
      });
      if (bankrollIds !== undefined) {
        await tx.contaBankroll.deleteMany({ where: { contaId: params.contaId } });
        if (bankrollIds.length) {
          await tx.contaBankroll.createMany({
            data: bankrollIds.map((bankrollId) => ({ contaId: params.contaId, bankrollId })),
            skipDuplicates: true,
          });
        }
      }
      await tx.auditEvent.create({
        data: {
          actor,
          action: "conta.update",
          resource: "conta",
          resourceId: params.contaId,
          details: {
            from: {
              casaDeAposta: conta.casaDeAposta,
              titular: conta.titular,
            },
            casaDeAposta: casa,
            titular,
            apelido: apelido || null,
          },
        },
      });
    },
    options,
  );
}

export async function alterarStatusConta(
  params: {
    contaId: string;
    status: ContaStatus;
    /** Estado visto pela tela; impede uma aba antiga de sobrescrever a nova. */
    expectedStatus?: ContaStatus;
    actor?: string;
  },
  options?: { client?: SerializableTransactionClient },
): Promise<void> {
  await runSerializableTransaction(
    "alterarStatusConta",
    async (tx) => {
      const conta = await tx.conta.findFirst({
        where: { id: params.contaId, deletedAt: null },
        select: { id: true, status: true },
      });
      if (!conta) {
        throw new RecusaDeNegocioError(`Conta ${params.contaId} inexistente ou removida.`);
      }
      // Mesmo status não é mudança e não entra na trilha. Reabrir uma conta
      // ENCERRADA continua permitido: é decisão do operador.
      if (conta.status === params.status) return;
      const expectedStatus = params.expectedStatus ?? conta.status;
      if (conta.status !== expectedStatus) {
        throw new RecusaDeNegocioError(
          "A conta foi alterada em outra aba. Atualize a página antes de tentar novamente.",
        );
      }
      const changed = await tx.conta.updateMany({
        where: {
          id: conta.id,
          deletedAt: null,
          status: expectedStatus,
        },
        data: { status: params.status },
      });
      if (changed.count !== 1) {
        throw new RecusaDeNegocioError(
          "A conta foi alterada em outra aba. Atualize a página antes de tentar novamente.",
        );
      }
      await tx.auditEvent.create({
        data: {
          actor: params.actor?.trim() || "system",
          action: "conta.status",
          resource: "conta",
          resourceId: conta.id,
          details: { from: conta.status, status: params.status },
        },
      });
    },
    options,
  );
}

/**
 * Soft-delete: histórico preservado.
 *
 * Nenhuma aposta viva pode continuar apontando para uma conta removida. Mesmo
 * uma aposta já final pode voltar a PENDING ou trocar de resultado; nesse caso
 * o ledger precisa estornar na conta original. Removê-la antes disso tornaria
 * a correção impossível pelo caminho canônico.
 */
export async function removerConta(
  params: { contaId: string; actor?: string },
  options?: { client?: SerializableTransactionClient },
): Promise<void> {
  await runSerializableTransaction(
    "removerConta",
    async (tx) => {
      const conta = await tx.conta.findFirst({
        where: { id: params.contaId, deletedAt: null },
        select: {
          id: true,
          saldoAtual: true,
          _count: {
            select: { bets: { where: { deletedAt: null } } },
          },
        },
      });
      if (!conta) return;
      if (Math.abs(roundMoney(toNumber(conta.saldoAtual), 2)) >= LEDGER_MIN_AMOUNT) {
        throw new RecusaDeNegocioError("Zere o saldo da conta antes de removê-la.");
      }
      if (conta._count.bets > 0) {
        throw new RecusaDeNegocioError(
          "Remova ou desvincule as apostas vivas antes de remover a conta.",
        );
      }
      const ledger = await tx.movimentacao.aggregate({
        where: { contaId: conta.id }, _sum: { valor: true },
      });
      if (roundMoney(toNumber(ledger._sum.valor ?? 0), 2) !== roundMoney(toNumber(conta.saldoAtual), 2)) {
        throw new RecusaDeNegocioError("Reconcilie o saldo com as movimentações antes de remover a conta.");
      }
      // O vínculo atual não basta: lançamentos antigos podem continuar
      // exigindo estorno mesmo depois de a aposta trocar/perder a conta.
      const efeitosPendentes = await tx.$queryRaw<Array<{ betId: string }>>`
        SELECT "betId" FROM movimentacoes
        WHERE "contaId" = ${conta.id} AND "betId" IS NOT NULL
        GROUP BY "betId" HAVING sum(valor) <> 0
        LIMIT 1
      `;
      if (efeitosPendentes.length > 0) {
        throw new RecusaDeNegocioError(
          "Reconcilie os lançamentos de apostas desta conta antes de removê-la.",
        );
      }
      await tx.conta.update({
        where: { id: conta.id },
        data: { deletedAt: new Date(), status: "ENCERRADA" },
      });
      await tx.auditEvent.create({
        data: {
          actor: params.actor?.trim() || "system",
          action: "conta.delete",
          resource: "conta",
          resourceId: conta.id,
        },
      });
    },
    options,
  );
}


function isClientMutationIdViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  if (typeof target === "string") return target.includes("clientMutationId");
  return Array.isArray(target) && target.some((item) => String(item).includes("clientMutationId"));
}

type ExistingManualMovement = {
  contaId: string;
  tipo: MovimentacaoTipo;
  valor: Prisma.Decimal;
  saldoApos: Prisma.Decimal;
};

function deduplicatedMovementResult(
  movement: ExistingManualMovement,
  expected: { contaId: string; tipo: MovimentacaoTipo; delta: number },
): { saldoApos: number; deduplicado: true } {
  if (
    movement.contaId !== expected.contaId ||
    movement.tipo !== expected.tipo ||
    Math.abs(toNumber(movement.valor) - expected.delta) >= LEDGER_MIN_AMOUNT
  ) {
    throw new RecusaDeNegocioError(
      "Identificador de idempotência já foi usado em outra movimentação.",
    );
  }
  return { saldoApos: toNumber(movement.saldoApos), deduplicado: true };
}

/**
 * Movimentação manual nunca tem betId. Saldo e ledger mudam na mesma transação
 * Serializable, com `saldoApos` como snapshot auditável.
 */
export async function registrarMovimentacaoManual(
  params: {
    contaId: string;
    tipo: MovimentacaoTipo;
    valor: number;
    descricao?: string;
    actor?: string;
    clientMutationId: string;
  },
  options?: { client?: SerializableTransactionClient },
): Promise<{ saldoApos: number; deduplicado: boolean }> {
  if (!MANUAL_MOVEMENT_TYPES.has(params.tipo)) {
    throw new RecusaDeNegocioError(`Tipo ${params.tipo} não é movimentação manual.`);
  }
  if (typeof params.clientMutationId !== "string") {
    throw new RecusaDeNegocioError("Identificador de idempotência inválido.");
  }
  const clientMutationId = params.clientMutationId.trim();
  if (!isManualMovementId(clientMutationId)) {
    throw new RecusaDeNegocioError("Identificador de idempotência inválido.");
  }
  const bruto = roundMoney(params.valor, 2);
  const actor = params.actor?.trim() || "system";
  const descricao = limitedText(params.descricao, "Descrição", MAX_DESCRIPTION_LENGTH);
  if (!Number.isFinite(bruto)) throw new RecusaDeNegocioError("Valor inválido.");
  if (Math.abs(bruto) > MAX_ACCOUNT_BALANCE) {
    throw new RecusaDeNegocioError("Valor excede o limite financeiro da conta.");
  }

  const magnitude = params.tipo === "AJUSTE_MANUAL" ? Math.abs(bruto) : bruto;
  if (magnitude < LEDGER_MIN_AMOUNT) {
    throw new RecusaDeNegocioError("Valor inválido (mínimo meio centavo).");
  }
  const delta = params.tipo === "SAQUE" ? -bruto : bruto;

  try {
    return await runSerializableTransaction(
      "registrarMovimentacaoManual",
      async (tx) => {
        const jaGravada = await tx.movimentacao.findUnique({
          where: { clientMutationId },
          select: { contaId: true, tipo: true, valor: true, saldoApos: true },
        });
        if (jaGravada) {
          const result = deduplicatedMovementResult(jaGravada, {
            contaId: params.contaId,
            tipo: params.tipo,
            delta,
          });
          log.info(
            { contaId: params.contaId, tipo: params.tipo, via: "reenvio" },
            "movimentação manual deduplicada pela chave de idempotência",
          );
          return result;
        }
        return gravarMovimentacaoManualTx(tx, {
          contaId: params.contaId,
          tipo: params.tipo,
          delta,
          descricao,
          actor,
          clientMutationId,
        });
      },
      options,
    );
  } catch (error) {
    if (!isClientMutationIdViolation(error)) throw error;
    const vencedora = await runSerializableTransaction(
      "deduplicarMovimentacaoManual",
      (tx) => tx.movimentacao.findUnique({
        where: { clientMutationId },
        select: { contaId: true, tipo: true, valor: true, saldoApos: true },
      }),
      options,
    );
    if (!vencedora) throw error;
    const result = deduplicatedMovementResult(vencedora, {
      contaId: params.contaId,
      tipo: params.tipo,
      delta,
    });
    log.info(
      { contaId: params.contaId, tipo: params.tipo, via: "corrida" },
      "movimentação manual deduplicada pela chave de idempotência",
    );
    return result;
  }
}

async function gravarMovimentacaoManualTx(
  tx: Prisma.TransactionClient,
  params: {
    contaId: string;
    tipo: MovimentacaoTipo;
    delta: number;
    descricao: string;
    actor: string;
    clientMutationId: string;
  },
): Promise<{ saldoApos: number; deduplicado: boolean }> {
  const { delta, descricao, actor, clientMutationId } = params;
  const conta = await tx.conta.findFirst({
    where: { id: params.contaId, deletedAt: null },
    select: { id: true, saldoAtual: true, status: true },
  });
  if (!conta) {
    throw new RecusaDeNegocioError(`Conta ${params.contaId} inexistente ou removida.`);
  }
  if (conta.status === "ENCERRADA") {
    throw new RecusaDeNegocioError(`Conta ${params.contaId} está encerrada e não aceita movimentações.`);
  }
  if (conta.status === "LIMITADA" && params.tipo !== "SAQUE") {
    throw new RecusaDeNegocioError(`Conta ${params.contaId} está limitada e aceita apenas saques.`);
  }
  const saldoApos = roundMoney(toNumber(conta.saldoAtual) + delta, 2);
  if (Math.abs(saldoApos) > MAX_ACCOUNT_BALANCE) {
    throw new RecusaDeNegocioError("Saldo excede o limite financeiro da conta.");
  }
  // O piso é da saída: a conta que a aposta perdida deixou negativa ainda recebe dinheiro.
  if (delta < 0 && saldoApos < -LEDGER_MIN_AMOUNT) {
    throw new RecusaDeNegocioError(params.tipo === "SAQUE"
      ? "Saque maior que o saldo disponível."
      : "Ajuste negativo maior que o saldo disponível.");
  }
  await tx.conta.update({
    where: { id: conta.id },
    data: { saldoAtual: { increment: delta } },
  });
  const movimentacao = await tx.movimentacao.create({
    data: {
      contaId: conta.id,
      tipo: params.tipo,
      valor: delta,
      saldoApos,
      descricao: descricao || null,
      actor,
      clientMutationId,
    },
    select: { id: true },
  });
  await tx.auditEvent.create({
    data: {
      actor,
      action: "conta.movement",
      resource: "movimentacao",
      resourceId: movimentacao.id,
      // A chave de idempotência entra na trilha para a linha de auditoria ser
      // autocontida: sem ela, provar qual clique foi absorvido exigiria voltar à
      // `movimentacao` pelo `resourceId`.
      details: { contaId: conta.id, tipo: params.tipo, valor: delta, saldoApos, clientMutationId },
    },
  });
  return { saldoApos, deduplicado: false };
}
