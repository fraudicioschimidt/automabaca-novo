"use server";

import { revalidatePath } from "next/cache";
import { revalidateFinancialViews } from "../../_revalidate";
import { BetStatus } from "@/src/generated/prisma/client";
import type { SharpMode } from "@/src/generated/prisma/client";
import {
  betExportFilename,
  buildBetExportCsv,
} from "@/src/domain/bet-export";
import { prisma } from "@/src/infra/prisma";
import { settleManualFromView } from "@/src/services/bets/manual-settlement";
import type { ManualSettlementConfirmation, ManualSettlementResult } from "@/src/domain/manual-settlement";
import { editarBankroll } from "@/src/services/bankrolls/manage";
import { betRowToExportInput } from "@/src/services/painel/bet-export-map";
import { fetchAllBankrollBetsForExport, getBankrollBySlug } from "@/src/services/painel/queries/bankrolls";
import { runClosingSyncOnce } from "@/src/services/sharp/closing/sync";
import { type ClosingSyncResult, CLOSING_MANUAL_BUDGET_MS } from "@/src/services/sharp/closing/types";
import { withProviderWorkBudget } from "@/src/infra/provider-work-budget";
import { actor, requireSession } from "../../_auth";
import { observeAction } from "@/app/_lib/observed-action";
import {
  RecusaDeNegocioError,
  recusaMessageOrThrow,
  refusalAsResult,
  type ActionResult,
} from "@/src/services/shared/recusa";

export type ExportBankrollCsvResult = {
  csv: string;
  count: number;
  filename: string;
};

// Slug malformado é defeito do cliente e segue como erro; banca que sumiu
// (excluída em outra aba) volta como recusa, com a mensagem até a tela.
function parseSlug(slug: unknown): string {
  if (typeof slug !== "string" || !slug.trim()) throw new Error("Tipster inválido.");
  return slug;
}

async function requireBankroll(slug: string) {
  const bk = await getBankrollBySlug(slug);
  if (!bk) throw new RecusaDeNegocioError(`Tipster "${slug}" não encontrado.`);
  return bk;
}

/**
 * Exporta TODAS as apostas da banca em CSV (histórico completo, não só as
 * ~300 da ficha). Leitura exige sessão (`requireSession`).
 */
export async function exportBankrollCsvAction(
  slug: string,
): Promise<ActionResult<ExportBankrollCsvResult>> {
  await requireSession();
  const parsedSlug = parseSlug(slug);
  return refusalAsResult(async () => {
    const bk = await requireBankroll(parsedSlug);
    const rows = await observeAction("bankroll.export", () => fetchAllBankrollBetsForExport(bk.id));
    const csv = buildBetExportCsv(rows.map(betRowToExportInput));
    return { csv, count: rows.length, filename: betExportFilename(parsedSlug) };
  });
}

/**
 * Botão "Odds fechamento" da ficha: roda o `closing.sync` só desta banca, para
 * as apostas cujo jogo já começou e ainda não têm fechamento (a Pinnacle17
 * congela o que a agenda gravou antes do apito; a Bridge é consultada). O
 * race-guard do `writeClosingOnce` cobre a concorrência com o cron. Roda inline
 * porque o operador espera o resultado na hora (e o ciclo é isolado por item).
 */
export async function buscarFechamentoAction(slug: string): Promise<ActionResult<ClosingSyncResult>> {
  await requireSession();
  const parsedSlug = parseSlug(slug);
  return refusalAsResult(async () => {
    const bk = await requireBankroll(parsedSlug);
    // Orçamento de provedor: sem ele, esta requisição podia ficar MINUTOS presa.
    // O lote chega a 150 apostas e cada partida sem cache espera a cadência do
    // BridgeOdds (90/h ≈ 40s por chamada), tudo segurando uma conexão do pool de
    // 10 — e cada nova tentativa do operador reservava slots no gate global,
    // empurrando o cron de 5 minutos para trás.
    //
    // Com orçamento, `awaitProviderCadence` recusa ANTES de reservar quando não
    // cabe: a aposta volta como `adiadas` e o ciclo automático a pega depois.
    // 25s é o que um clique tolera sem parecer travado, e o resto do lote é
    // trabalho de fundo por natureza.
    const result = await observeAction("closing.sync_manual", () =>
      withProviderWorkBudget("bridgeodds", CLOSING_MANUAL_BUDGET_MS, () =>
        runClosingSyncOnce({ bankrollId: bk.id }),
      ),
    );
    // O ciclo pode ter gravado fechamento e CLV (nunca liquida: resultado é do
    // FlashScore) — a tabela da ficha precisa refletir na próxima navegação.
    revalidateFinancialViews(parsedSlug);
    return result;
  });
}

// Rótulo da tela → BetStatus. Cobre TODOS os resultados manuais (cashout pede
// valor; CANCELED não entra aqui — é o "não peguei"/soft-delete).
const STATUS_BY_RESULT = {
  won: BetStatus.WON,
  halfwon: BetStatus.HALF_WON,
  lost: BetStatus.LOST,
  half: BetStatus.HALF_LOST,
  void: BetStatus.VOID,
  cashout: BetStatus.CASHOUT,
  pending: BetStatus.PENDING,
} as const;
export type SettleResult = keyof typeof STATUS_BY_RESULT;
export type SettleBetActionResult = ManualSettlementResult | { erro: string };

/**
 * Altera o resultado de UMA aposta a partir do histórico da banca, em qualquer
 * um dos 7 status. Usa `settleManualFromView`: a transação reverte o efeito
 * anterior no ledger antes de aplicar o novo, então corrigir um resultado já
 * liquidado não duplica nem deixa saldo órfão.
 */
export async function settleBetAction(
  slug: string,
  betId: string,
  result: SettleResult,
  cashoutLucro?: number,
  confirmation?: ManualSettlementConfirmation,
): Promise<SettleBetActionResult> {
  const who = await actor();
  try {
    if (typeof slug !== "string" || !slug) throw new RecusaDeNegocioError("Tipster inválido.");
    if (typeof betId !== "string" || !betId) throw new RecusaDeNegocioError("Aposta inválida.");
    // Valida o literal contra a allowlist: um result forjado
    // cairia em status indefinido ou desliquidaria a aposta em silêncio.
    if (!Object.hasOwn(STATUS_BY_RESULT, result)) {
      throw new RecusaDeNegocioError(`Resultado inválido: ${String(result)}`);
    }
    const newStatus = STATUS_BY_RESULT[result];
    // CASHOUT exige o lucro manual; o motor valida o teto (-stake … stake·(odds-1)).
    if (
      newStatus === BetStatus.CASHOUT &&
      (typeof cashoutLucro !== "number" || !Number.isFinite(cashoutLucro))
    ) {
      throw new RecusaDeNegocioError("Cashout exige o valor do lucro (em unidades).");
    }
    const bk = await getBankrollBySlug(slug);
    if (!bk) throw new RecusaDeNegocioError(`Tipster "${slug}" não encontrado.`);
    // Amarrar bet ↔ banca do slug — impede liquidar aposta de outra banca via ID forjado.
    const bet = await prisma.bet.findFirst({
      where: { id: betId, bankrollId: bk.id, deletedAt: null },
      select: { id: true },
    });
    if (!bet) throw new RecusaDeNegocioError("Aposta não encontrada neste tipster.");
    const settled = await observeAction("bet.settle", async () =>
      settleManualFromView({ betId, bankrollSlug: slug, newStatus, cashoutLucro, confirmation, source: `manual:${who}` }),
    );
    revalidateFinancialViews(slug);
    return settled;
  } catch (error) {
    return { erro: recusaMessageOrThrow(error) };
  }
}

const VALID_SHARP_MODES = new Set<string>(["CLV_ONLY", "IDENTITY_ONLY", "OFF"]);

/**
 * Altera o modo sharp de uma banca diretamente da ficha da banca.
 */
export async function updateBankrollSharpModeAction(
  slug: string,
  sharpMode: "CLV_ONLY" | "IDENTITY_ONLY" | "OFF",
): Promise<ActionResult> {
  const who = await actor();
  const parsedSlug = parseSlug(slug);
  // Modo fora da lista só chega forjado: defeito do cliente, não recusa.
  if (!VALID_SHARP_MODES.has(sharpMode)) {
    throw new Error(`Modo sharp inválido: ${String(sharpMode)}`);
  }
  return refusalAsResult(async () => {
    const bk = await requireBankroll(parsedSlug);
    await observeAction("bankroll.update_sharp_mode", () =>
      editarBankroll(bk.id, { sharpMode: sharpMode as SharpMode }, who),
    );
    revalidateFinancialViews(parsedSlug);
    revalidatePath("/tipsters");
    revalidatePath("/config");
    return {};
  });
}

