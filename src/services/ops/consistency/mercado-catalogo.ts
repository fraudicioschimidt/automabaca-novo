import { OperationalRisk } from "@/src/generated/prisma/client";
import { isMercadoFinalForSport } from "@/src/domain/mercados/compatibility";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { normalizeMercado } from "@/src/services/mercados/normalize";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { reconcileOperationalActionSource } from "@/src/services/ops/operational-actions";
import { buildPlayerPropTerms } from "@/src/domain/settlement/player-prop-terms";
import { canonicalSport } from "@/src/domain/sports/registry";
import { classifyScoreMarket } from "@/src/domain/settlement/markets";
import { normalizeStr } from "@/src/domain/text";
import { isEsportsPlayerSelection } from "@/src/domain/mercados/selection-shape";

const log = createLogger("mercado-catalogo");
const BATCH_SIZE = 1_000;

export type MercadoForaDoCatalogo = {
  betId: string;
  evento: string;
  esporte: string;
  mercadoGravado: string;
  /** Para onde o catálogo levaria hoje; null = nem com alias novo resolve. */
  mercadoSugerido: string | null;
};

/**
 * Toda aposta viva tem que ter `mercado` no vocabulário Pinnacle.
 *
 * Mercado que o pipeline (`normalizeMercado`) não conhece é gravado cru, para
 * não perder dado; aqui o desvio vira ação operacional que fica na fila até
 * alguém cadastrar o alias em /config/mercados e corrigir a aposta (o aviso no
 * Telegram rola e some). Não corrige nada sozinho: nome de mercado é chave de
 * segmento (a probation lê `esporte|mercado`), e reescrever em silêncio moveria
 * a aposta de segmento. `mercadoSugerido` entrega a resposta quando o catálogo
 * do banco já daria conta (alias adicionado depois da captura): é o mesmo
 * `normalizeMercado` do registro, que a edição da aposta roda de novo.
 */
export async function checkMercadoForaDoCatalogo(now = new Date()): Promise<{
  verificadas: number;
  divergentes: MercadoForaDoCatalogo[];
}> {
  const divergentes: MercadoForaDoCatalogo[] = [];
  let verificadas = 0;
  let cursor: string | undefined;
  for (;;) {
    const bets = await prisma.bet.findMany({
      where: { deletedAt: null },
      select: { id: true, evento: true, esporte: true, mercado: true, selecao: true, bankroll: { select: { sharpMode: true } } },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (bets.length === 0) break;
    verificadas += bets.length;
    for (const bet of bets) {
      // Sport resolution has its own queue/action. Without it there is no
      // sport-specific market catalogue to compare against yet.
      if (!canonicalSport(bet.esporte)) continue;
      // Capture intentionally preserves individual kills/deaths as Player
      // Props. A missing Pinnacle display label is not a malformed market.
      if (bet.esporte === "eSports" && bet.mercado === "Player Props"
        && isEsportsPlayerSelection(bet.selecao, bet.evento)) continue;
      const prop = bet.bankroll.sharpMode === "IDENTITY_ONLY" ? buildPlayerPropTerms(bet) : null;
      if (prop?.jogador && prop.direction && prop.lineQuarters !== null && !prop.unsupportedReason) continue;
      if (bet.esporte === "Soccer" && ["Total (Shots) – Match", "Team Total (Shots) – Match"].includes(bet.mercado)) continue;
      // This explicit statistic is retained by capture and settlement even
      // though the historic display-label catalogue does not list it.
      if (bet.esporte === "Basketball" && bet.mercado === "Team Total (Points)" && classifyScoreMarket(normalizeStr(bet.mercado), normalizeStr(bet.selecao), bet.evento) === "team_total") continue;
      if (isMercadoFinalForSport(bet.mercado, bet.esporte)) continue;
      const sugerido = await normalizeMercado(bet.mercado, { esporte: bet.esporte });
      divergentes.push({
        betId: bet.id,
        evento: bet.evento,
        esporte: bet.esporte,
        mercadoGravado: bet.mercado,
        mercadoSugerido: sugerido.matched ? sugerido.mercado : null,
      });
    }
    cursor = bets[bets.length - 1]?.id;
    if (bets.length < BATCH_SIZE) break;
  }

  for (const d of divergentes) {
    const saida = d.mercadoSugerido
      ? `👉 O catálogo atual já reconhece como "${d.mercadoSugerido}": edite a aposta ${d.betId} e salve.`
      : `👉 Cadastre o nome em Config › Mercados e edite a aposta ${d.betId}.`;
    await sendOperationalAlert(
      `🏷️ Mercado desconhecido · ${d.evento} (${d.esporte})\n` +
        `A aposta foi gravada com o mercado "${d.mercadoGravado}", que não existe na Pinnacle.\n${saida}`,
      {
        source: "consistency.mercado-catalogo",
        key: d.betId,
        title: "Mercado fora do vocabulário Pinnacle",
        risk: OperationalRisk.MEDIUM,
        resource: "bet",
        resourceId: d.betId,
        evidence: {
          esporte: d.esporte,
          mercadoGravado: d.mercadoGravado,
          mercadoSugerido: d.mercadoSugerido,
        },
      },
    );
    log.warn({ ...d }, "mercado fora do catálogo Pinnacle");
  }

  if (verificadas > 0) {
    log.info(
      { verificadas, divergentes: divergentes.length },
      "consistency-check de mercado concluído",
    );
  }
  await reconcileOperationalActionSource(
    "consistency.mercado-catalogo",
    divergentes.map((d) => d.betId),
    now,
  );
  return { verificadas, divergentes };
}
