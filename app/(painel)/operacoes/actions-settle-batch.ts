import { revalidatePath } from "next/cache";
import { revalidateFinancialViews } from "../_revalidate";
import { BetStatus } from "@/src/generated/prisma/client";
import { z } from "zod";
import {
  SETTLEMENT_MANUAL_BATCH_MAX,
  fonteDoPayloadDeSettlement,
  loteAlcancaAposta,
  lotePodeDesfazer,
} from "@/src/domain/settlement/manual-batch";
import { admitsAsianFractionalSettlement } from "@/src/domain/settlement/half-guard";
import { logger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { BetNotPendingError } from "@/src/services/bets/settle";
import { settleManualFromView } from "@/src/services/bets/manual-settlement";
import { actor } from "../_auth";
import { observeAction } from "@/app/_lib/observed-action";

/**
 * Settlement manual a partir do cockpit de Operações (a fila Liquidar manda uma
 * aposta por vez, e o desfazer do toast a devolve a pendente): marca cada aposta
 * como ganha/perdida (ou volta a pendente, no desfazer) pelo ÚNICO caminho de
 * settlement do AutomaBACA (`settleManualFromView` — CAS de versão + recibo,
 * transação Serializable + reconcilia ledger + evento idempotente). A versão é
 * a que a tela mostrou e o `requestId` é o do clique: a aposta que mudou
 * depois de a página abrir volta como conflito, sem liquidar. Isola por aposta
 * (1 falha não aborta o lote) e revalida /operacoes para a lista refletir o
 * estado real. `versions` traz a versão nova de cada aposta gravada, para o
 * desfazer.
 */
export type SettleBetRequest = { betId: string; expectedVersion: number; requestId: string };

export async function settleBetsAction(
  items: SettleBetRequest[],
  result: "won" | "half_won" | "lost" | "half_lost" | "void" | "pending",
): Promise<{ failures: number; ignoradas: number; conflicts: number; halfRefused: number; mutadas: string[]; versions: Record<string, number> }> {
  const who = await actor();
  // Input hostil: valida o literal em runtime — sem isto, result malformado
  // cairia no ramo final e desliquidaria a aposta (PENDING) em silêncio. "void" =
  // reembolso/anulada (push, evento cancelado) — sem ele o operador seria forçado
  // a marcar ganhou/perdeu numa aposta que devia devolver a stake.
  if (
    result !== "won" &&
    result !== "half_won" &&
    result !== "lost" &&
    result !== "half_lost" &&
    result !== "void" &&
    result !== "pending"
  ) {
    throw new Error(`Resultado inválido: ${String(result)}`);
  }
  const parsedItems = z.array(z.object({
    betId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    requestId: z.string().uuid(),
  }).strict())
    .min(1)
    .max(SETTLEMENT_MANUAL_BATCH_MAX)
    .safeParse(items);
  if (!parsedItems.success) {
    throw new Error(`betIds inválidos (esperado 1–${SETTLEMENT_MANUAL_BATCH_MAX} UUIDs, com a versão exibida e o id do pedido).`);
  }
  const betIds = parsedItems.data.map((item) => item.betId);
  const newStatus =
    result === "won"
      ? BetStatus.WON
      : result === "half_won"
        ? BetStatus.HALF_WON
      : result === "lost"
        ? BetStatus.LOST
        : result === "half_lost"
          ? BetStatus.HALF_LOST
        : result === "void"
          ? BetStatus.VOID
          : BetStatus.PENDING;
  // A borda não confia no cliente: entre o clique e o commit o liquidador
  // automático ainda pode resolver a aposta, e 328 das 339 liquidações da
  // produção vêm dele. Sem este filtro, o lote sobrescreveria um resultado
  // correto carimbando `manual:<quem>`. `loteAlcancaAposta` é direcional — o
  // desfazer (`pending`) precisa alcançar a aposta recém-terminal DESTE
  // operador (`lotePodeDesfazer`), não um placar automático.
  const estados = await prisma.bet.findMany({
    where: { id: { in: betIds } },
    select: {
      id: true, status: true, mercado: true, selecao: true,
      bankroll: { select: { slug: true } },
    },
  });
  const porId = new Map(estados.map((b) => [b.id, b]));
  const ultimaFonte = new Map<string, string | null>();
  if (newStatus === BetStatus.PENDING) {
    const eventos = await prisma.settlementEvent.findMany({
      where: { betId: { in: betIds }, type: "STATUS_CHANGED" },
      orderBy: { createdAt: "desc" },
      select: { betId: true, payload: true },
    });
    for (const evento of eventos) {
      if (!ultimaFonte.has(evento.betId)) {
        ultimaFonte.set(evento.betId, fonteDoPayloadDeSettlement(evento.payload));
      }
    }
  }
  const alcancaveis: typeof parsedItems.data = [];
  const ignoradas: string[] = [];
  for (const item of parsedItems.data) {
    const { betId } = item;
    const atual = porId.get(betId);
    // Id que não existe mais segue para o caminho normal e falha ruidoso lá:
    // sumir da contagem seria esconder um id inválido.
    const alcança = atual === undefined
      ? true
      : newStatus === BetStatus.PENDING
        ? lotePodeDesfazer(atual.status, ultimaFonte.get(betId) ?? null, who)
        : loteAlcancaAposta(atual.status, newStatus);
    if (alcança) alcancaveis.push(item);
    else ignoradas.push(betId);
  }
  if (ignoradas.length) {
    logger.warn(
      { mod: "settle-action", result, ignoradas: ignoradas.length, betIds: ignoradas },
      "lote manual ignorou apostas que já estavam liquidadas",
    );
  }
  let failures = 0;
  // Recusa com motivo que a tela diz ao operador, não falha a investigar.
  let halfRefused = 0;
  let conflicts = 0;
  const mutadasComSucesso: string[] = [];
  const versions: Record<string, number> = {};
  for (const { betId, expectedVersion, requestId } of alcancaveis) {
    const betInfo = porId.get(betId);
    if (
      betInfo &&
      (newStatus === BetStatus.HALF_WON || newStatus === BetStatus.HALF_LOST) &&
      !admitsAsianFractionalSettlement(betInfo.mercado ?? "", betInfo.selecao ?? "")
    ) {
      halfRefused += 1;
      logger.warn(
        { mod: "settle-action", betId, result, mercado: betInfo.mercado, selecao: betInfo.selecao },
        "SET-001: mercado puramente binário não admite meio-ganho/meio-perdido",
      );
      continue;
    }
    try {
      if (!betInfo?.bankroll?.slug) {
        failures += 1;
        logger.error(
          { mod: "settle-action", betId, result },
          "lote manual sem banca para CAS/recibo",
        );
        continue;
      }
      const reply = await observeAction("bet.settle_batch_item", () =>
        settleManualFromView({
          betId,
          newStatus: newStatus,
          source: `manual:${who}`,
          requirePending: newStatus !== BetStatus.PENDING,
          bankrollSlug: betInfo.bankroll.slug,
          confirmation: { expectedVersion, requestId },
        }),
      );
      if (reply.kind === "saved") {
        mutadasComSucesso.push(betId);
        versions[betId] = reply.current.version;
      } else if (reply.kind === "conflict") {
        conflicts += 1;
        logger.info(
          { mod: "settle-action", betId, result, expectedVersion, currentVersion: reply.current.version },
          "aposta mudou depois de exibida; resultado manual não aplicado",
        );
      } else {
        failures += 1;
        logger.error(
          { mod: "settle-action", betId, result, reply },
          "falha ao liquidar aposta no lote (CAS/recibo)",
        );
      }
    } catch (err) {
      if (err instanceof BetNotPendingError) {
        ignoradas.push(betId);
        logger.info(
          { mod: "settle-action", betId, result, err },
          "aposta liquidada concorrentemente ignorada no lote",
        );
        continue;
      }
      failures += 1;
      logger.error({ mod: "settle-action", betId, result, err }, "falha ao liquidar aposta");
    }
  }
  revalidatePath("/operacoes");
  revalidateFinancialViews();
  return { failures, ignoradas: ignoradas.length, conflicts, halfRefused, mutadas: mutadasComSucesso, versions };
}
