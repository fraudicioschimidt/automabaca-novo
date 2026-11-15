"use server";

import { MAX_BANKROLL_SLUG_INPUT_LENGTH } from "@/src/domain/bankroll-identity";
import { ALL_BET_STATUSES } from "@/src/domain/bet-status";
import type { ManualBetInput } from "@/src/domain/manual-bet";
import { prisma } from "@/src/infra/prisma";
import { editManualBet, registerManualBet } from "@/src/services/bets/manual";
import {
  planBatchRemoval,
  removeBetsInBatch,
  restoreBetsInBatch,
  softDeleteBet,
  type BatchRemovalPlan,
  type ConfirmedRemoval,
} from "@/src/services/bets/remove";
import { observeAction } from "@/app/_lib/observed-action";
import { getBankrollBySlug } from "@/src/services/painel/queries/bankrolls";
import { actor } from "../../_auth";
import { revalidateFinancialViews } from "../../_revalidate";
import { RecusaDeNegocioError, refusalAsResult, type ActionResult } from "@/src/services/shared/recusa";
import { z } from "zod";

export type RegisterManualBetInput = ManualBetInput & { requestId: string };
export type EditBetInput = ManualBetInput;

const bankrollSlugSchema = z
  .string()
  .trim()
  .min(1, "Tipster inválido.")
  .max(MAX_BANKROLL_SLUG_INPUT_LENGTH)
  .regex(/^[a-z0-9-]+$/, "Tipster inválido.");

const betIdSchema = z.string().uuid("Aposta inválida.");
const betVersionSchema = z.number().int().positive();

const manualBetInputSchema = z
  .object({
    home: z.string().trim().min(1).max(200),
    away: z.string().trim().min(1).max(200),
    date: z.string().trim().min(1).max(32),
    time: z.string().trim().max(16).optional(),
    esporte: z.string().trim().max(64).optional(),
    region: z.string().trim().max(120).optional(),
    competition: z.string().trim().max(200).optional(),
    market: z.string().trim().max(120).optional(),
    line: z.string().trim().max(200).optional(),
    odds: z.union([z.number().finite(), z.string().trim().min(1).max(32)]),
    stake: z.union([z.number().finite(), z.string().trim().min(1).max(32)]),
    casa: z.string().trim().max(120).optional(),
  })
  .strict();

// Slug ou id malformado é defeito do cliente e segue como erro; o que o
// operador preencheu volta como recusa, com a mensagem até a tela.
function parseBankrollSlug(value: unknown): string {
  const parsed = bankrollSlugSchema.safeParse(value);
  if (!parsed.success) throw new Error("Tipster inválido.");
  return parsed.data;
}

function parseBetId(value: unknown): string {
  const parsed = betIdSchema.safeParse(value);
  if (!parsed.success) throw new Error("Aposta inválida.");
  return parsed.data;
}

function parseBetVersion(value: unknown): number {
  const parsed = betVersionSchema.safeParse(value);
  if (!parsed.success) throw new Error("Versão da aposta inválida.");
  return parsed.data;
}

function parseManualBetInput(value: unknown): ManualBetInput {
  const parsed = manualBetInputSchema.safeParse(value);
  if (!parsed.success) throw new RecusaDeNegocioError("Dados da aposta inválidos.");
  return parsed.data;
}

async function requireBankroll(slug: string) {
  const bankroll = await getBankrollBySlug(slug);
  if (!bankroll) throw new RecusaDeNegocioError(`Tipster "${slug}" não encontrado.`);
  return bankroll;
}

/**
 * A aposta tem de existir nesta banca. Aposta já removida (outra aba, o 👎 no
 * canal) é recusa com motivo, não falha.
 */
async function requireBankrollBet(slug: string, betId: string) {
  const bankroll = await requireBankroll(slug);
  const bet = await prisma.bet.findFirst({
    where: { id: betId, bankrollId: bankroll.id, deletedAt: null },
    select: { id: true },
  });
  if (!bet) throw new RecusaDeNegocioError("Aposta não encontrada neste tipster.");
  return bankroll;
}

export async function registerManualBetAction(
  slug: string,
  input: RegisterManualBetInput,
): Promise<ActionResult<{ betId: string; created: boolean }>> {
  const who = await actor();
  return refusalAsResult(async () => {
    const parsedSlug = parseBankrollSlug(slug);
    const parsed = manualBetInputSchema.extend({ requestId: z.uuid() }).safeParse(input);
    if (!parsed.success) throw new RecusaDeNegocioError("Dados da aposta inválidos.");
    const { requestId, ...parsedInput } = parsed.data;
    const bankroll = await requireBankroll(parsedSlug);
    const result = await observeAction("bet.register", () =>
      registerManualBet(bankroll.id, parsedInput, who, requestId),
    );
    revalidateFinancialViews(parsedSlug);
    return { betId: result.betId, created: result.created };
  });
}

/** `expectedVersion`: a revisão da aposta que a ficha mostrava ao abrir o formulário. */
export async function editBetAction(
  slug: string,
  betId: string,
  input: EditBetInput,
  expectedVersion: number,
): Promise<ActionResult<{ requiresEnrich: boolean }>> {
  const who = await actor();
  return refusalAsResult(async () => {
    const parsedSlug = parseBankrollSlug(slug);
    const parsedBetId = parseBetId(betId);
    const parsedVersion = parseBetVersion(expectedVersion);
    const parsedInput = parseManualBetInput(input);
    await requireBankrollBet(parsedSlug, parsedBetId);
    const { requiresEnrich } = await observeAction("bet.edit", () =>
      editManualBet(parsedBetId, parsedInput, who, parsedVersion));
    revalidateFinancialViews(parsedSlug);
    return { requiresEnrich };
  });
}

export async function deleteBetAction(slug: string, betId: string): Promise<ActionResult> {
  const who = await actor();
  return refusalAsResult(async () => {
    const parsedSlug = parseBankrollSlug(slug);
    const parsedBetId = parseBetId(betId);
    await requireBankrollBet(parsedSlug, parsedBetId);
    await observeAction("bet.delete", async () =>
      softDeleteBet({
        betId: parsedBetId,
        actor: who,
        motivo: "Exclusão manual pelo painel",
        origin: "painel",
      }),
    );
    revalidateFinancialViews(parsedSlug);
    return {};
  });
}

/** Teto do lote: a tela marca o que vê, e o histórico mostra no máximo 300. */
const BATCH_REMOVAL_MAX = 300;
const betIdsSchema = z.array(betIdSchema).min(1).max(BATCH_REMOVAL_MAX);
/** A prévia soma as do mesmo post às marcadas: folga sobre o teto das marcadas. */
const CONFIRMED_REMOVAL_MAX = 4 * BATCH_REMOVAL_MAX;
const confirmedSchema = z.array(z.object({
  id: betIdSchema,
  status: z.enum(ALL_BET_STATUSES),
  lucro: z.number().finite(),
}).strict()).max(CONFIRMED_REMOVAL_MAX);

// Ids malformados são defeito do cliente: erro, não recusa.
function parseBetIds(value: unknown): string[] {
  const parsed = betIdsSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Apostas inválidas (esperado 1–${BATCH_REMOVAL_MAX}).`);
  return [...new Set(parsed.data)];
}

function parseConfirmed(value: unknown): ConfirmedRemoval[] {
  const parsed = confirmedSchema.safeParse(value);
  if (!parsed.success) throw new Error("Prévia da remoção inválida.");
  return parsed.data;
}

/** O que a remoção em lote faria (as do mesmo post juntas), para a confirmação. */
export async function previewBetRemovalAction(slug: string, betIds: string[]): Promise<ActionResult<{ plan: BatchRemovalPlan }>> {
  await actor();
  const parsedSlug = parseBankrollSlug(slug);
  const ids = parseBetIds(betIds);
  return refusalAsResult(async () => {
    const bankroll = await requireBankroll(parsedSlug);
    return { plan: await planBatchRemoval({ bankrollId: bankroll.id, betIds: ids }) };
  });
}

/**
 * Remove as apostas marcadas e as do mesmo post com o efeito do 👎: estorno e
 * restauráveis. `confirmed` é o lote que a prévia mostrou (id, status e lucro
 * de cada uma que sai); se ele mudou, a remoção é recusada. A liquidada há mais
 * de 7 dias fica e vira revisão; a resposta diz quais.
 */
export async function removeBetsAction(
  slug: string,
  betIds: string[],
  confirmed: ConfirmedRemoval[],
): Promise<ActionResult<{ plan: BatchRemovalPlan }>> {
  const who = await actor();
  const parsedSlug = parseBankrollSlug(slug);
  const ids = parseBetIds(betIds);
  const shown = parseConfirmed(confirmed);
  return refusalAsResult(async () => {
    const bankroll = await requireBankroll(parsedSlug);
    const plan = await observeAction("bet.batch_remove", () =>
      removeBetsInBatch({ bankrollId: bankroll.id, betIds: ids, confirmed: shown, actor: who }));
    revalidateFinancialViews(parsedSlug);
    return { plan };
  });
}

/** Restaura pelo painel: o "Desfazer" do toast, a lista "Removidas" e a ficha. */
export async function restoreBetsAction(slug: string, betIds: string[]): Promise<ActionResult<{ restored: string[]; blocked: string[] }>> {
  const who = await actor();
  const parsedSlug = parseBankrollSlug(slug);
  const ids = parseBetIds(betIds);
  return refusalAsResult(async () => {
    const bankroll = await requireBankroll(parsedSlug);
    const result = await observeAction("bet.batch_restore", () =>
      restoreBetsInBatch({ bankrollId: bankroll.id, betIds: ids, actor: who }));
    revalidateFinancialViews(parsedSlug);
    return result;
  });
}
