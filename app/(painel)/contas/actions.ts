"use server";

import { revalidateFinancialViews } from "../_revalidate";
import { canonicalizeBookmakerName } from "@/src/domain/bookmaker";
import type { ContaStatus, MovimentacaoTipo } from "@/src/generated/prisma/client";
import { MANUAL_MOVEMENT_TYPES, isManualMovementId } from "@/src/domain/account-policy";
import { LEDGER_MIN_AMOUNT } from "@/src/domain/money";
import {
  alterarStatusConta,
  criarConta,
  editarConta,
  registrarMovimentacaoManual,
  removerConta,
} from "@/src/services/contas/manage";
import { actor } from "../_auth";
import { observeAction } from "@/app/_lib/observed-action";
import { refusalAsResult, type ActionResult } from "@/src/services/shared/recusa";
import { z } from "zod";

/**
 * Mutações de Contas a partir da tela. Todas exigem sessão (`actor()` é a
 * guarda e já devolve o operador), validam a entrada, delegam a
 * `contas/manage` e revalidam as telas financeiras. A recusa de negócio volta
 * como resultado (`refusalAsResult`), porque o Next esconde a mensagem de erro
 * lançado em produção.
 */
export type ContaActionResult = ActionResult;

/** A conta não devolve o que o serviço gravou: a tela relê pela revalidação. */
function comRecusaDeNegocio(fn: () => Promise<unknown>): Promise<ContaActionResult> {
  return refusalAsResult(async () => {
    await fn();
    return {};
  });
}

const STATUS_VALIDOS: ReadonlySet<ContaStatus> = new Set(["ATIVA", "LIMITADA", "ENCERRADA"]);

/**
 * Contrato da borda: tipos, ids e tetos de tamanho. Os limites de negócio de
 * cada texto, com a mensagem ao operador, continuam no serviço; aqui o teto só
 * impede que entrada de tipo errado ou enorme chegue até ele.
 */
const TEXT_CEILING = 1_000;
const MAX_LINKED_BANKROLLS = 100;
const text = (invalid: string, tooLong: string) => z.string({ error: invalid }).max(TEXT_CEILING, tooLong);
const contaId = z.uuid({ error: "Conta inválida." });
const money = (label: string) => z.number({ error: `${label} inválido.` });
const bankrollIds = z.array(z.uuid({ error: "Tipster vinculado inválido." }), { error: "Tipsters vinculados inválidos." })
  .max(MAX_LINKED_BANKROLLS, "Tipsters vinculados demais.");

const contaFields = {
  casaDeAposta: text("Casa inválida.", "Casa longa demais."),
  titular: text("Titular inválido.", "Titular longo demais."),
  apelido: text("Apelido inválido.", "Apelido longo demais.").optional(),
  bankrollIds: bankrollIds.optional(),
};
const criarContaSchema = z.object({ ...contaFields, saldoInicial: money("Saldo inicial"), requestId: z.uuid({ error: "Identificador de criação inválido. Abra um novo formulário." }) }).strict();
const editarContaSchema = z.object({ ...contaFields, contaId }).strict();
const movimentarContaSchema = z.object({
  contaId,
  tipo: z.string({ error: "Tipo de movimentação inválido." })
    .refine((tipo) => MANUAL_MOVEMENT_TYPES.has(tipo), "Tipo de movimentação inválido."),
  valor: money("Valor"),
  descricao: text("Descrição inválida.", "Descrição longa demais.").optional(),
  clientMutationId: z.string({ error: "Identificador de idempotência inválido." })
    .refine(isManualMovementId, "Identificador de idempotência inválido."),
}).strict();

type ParsedInput<T> = { ok: true; data: T } | { ok: false; erro: string };

function parseInput<T>(schema: z.ZodType<T>, input: unknown): ParsedInput<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, erro: issue?.code === "unrecognized_keys" || !issue ? "Dados da conta inválidos." : issue.message };
}

export async function criarContaAction(input: {
  casaDeAposta: string;
  titular: string;
  apelido?: string;
  saldoInicial: number;
  requestId: string;
  bankrollIds?: string[];
}): Promise<ContaActionResult> {
  const who = await actor();
  const parsed = parseInput(criarContaSchema, input);
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  const resultado = await comRecusaDeNegocio(() =>
    observeAction("conta.create", () => criarConta({
      casaDeAposta: canonicalizeBookmakerName(data.casaDeAposta) || data.casaDeAposta,
      titular: data.titular,
      apelido: data.apelido,
      saldoInicial: data.saldoInicial,
      requestId: data.requestId,
      bankrollIds: data.bankrollIds,
      actor: who,
    })),
  );
  if (resultado.ok) revalidateFinancialViews();
  return resultado;
}

export async function movimentarContaAction(input: {
  contaId: string;
  tipo: MovimentacaoTipo;
  valor: number;
  descricao?: string;
  /** Cunhado pela tela ao abrir o formulário — ver `Movimentacao.clientMutationId`. */
  clientMutationId: string;
}): Promise<ContaActionResult> {
  const who = await actor();
  const parsed = parseInput(movimentarContaSchema, input);
  if (!parsed.ok) return parsed;
  const { tipo, valor, contaId: movedContaId, descricao, clientMutationId } = parsed.data;
  // AJUSTE_MANUAL aceita sinal (− débito); demais tipos exigem positivo.
  if (tipo === "AJUSTE_MANUAL") {
    // O piso vem do módulo dono do conceito, não de um literal repetido: esta
    // borda e o ledger precisam recusar EXATAMENTE o mesmo valor. Com `0.005`
    // escrito aqui, mudar o piso em `domain/money` deixaria a tela aceitando o
    // que a transação rejeita — divergência silenciosa no caminho do dinheiro.
    if (Math.abs(valor) < LEDGER_MIN_AMOUNT) {
      return { ok: false, erro: "Valor inválido (mínimo meio centavo)." };
    }
  } else if (valor <= 0) {
    return { ok: false, erro: "Valor inválido (deve ser positivo)." };
  }
  const resultado = await comRecusaDeNegocio(() =>
    observeAction("conta.movement", () => registrarMovimentacaoManual({
      contaId: movedContaId,
      tipo: tipo as MovimentacaoTipo,
      valor,
      descricao,
      actor: who,
      clientMutationId,
    })),
  );
  if (resultado.ok) revalidateFinancialViews();
  return resultado;
}

export async function editarContaAction(input: {
  contaId: string;
  casaDeAposta: string;
  titular: string;
  apelido?: string;
  bankrollIds?: string[];
}): Promise<ContaActionResult> {
  const who = await actor();
  const parsed = parseInput(editarContaSchema, input);
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  const resultado = await comRecusaDeNegocio(() =>
    observeAction("conta.update", () => editarConta({ ...data, actor: who })),
  );
  if (resultado.ok) revalidateFinancialViews();
  return resultado;
}

export async function alterarStatusContaAction(
  id: string,
  expectedStatus: ContaStatus,
  status: ContaStatus,
): Promise<ContaActionResult> {
  const who = await actor();
  if (!contaId.safeParse(id).success) return { ok: false, erro: "Conta inválida." };
  if (!STATUS_VALIDOS.has(expectedStatus)) {
    return { ok: false, erro: `Status atual inválido: ${String(expectedStatus)}` };
  }
  if (!STATUS_VALIDOS.has(status)) {
    return { ok: false, erro: `Status inválido: ${String(status)}` };
  }
  const resultado = await comRecusaDeNegocio(() =>
    observeAction("conta.status", () => alterarStatusConta({
      contaId: id,
      expectedStatus,
      status,
      actor: who,
    })),
  );
  if (resultado.ok) revalidateFinancialViews();
  return resultado;
}

export async function removerContaAction(id: string): Promise<ContaActionResult> {
  const who = await actor();
  if (!contaId.safeParse(id).success) return { ok: false, erro: "Conta inválida." };
  const resultado = await comRecusaDeNegocio(() =>
    observeAction("conta.delete", () => removerConta({ contaId: id, actor: who })),
  );
  if (resultado.ok) revalidateFinancialViews();
  return resultado;
}
