import "server-only";
import { spStartOfTodayUtc } from "@/src/domain/dates";
import { entrouAoVivo, JANELA_DE_JOGO_MS, type EntradaAoVivoParams } from "@/src/domain/entrada-ao-vivo";
import { instanteDaEntrada } from "@/src/domain/instante-da-entrada";
import { toNumber } from "@/src/domain/money";
import { judgeKickoffWindow } from "@/src/domain/settlement/eligibility";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { jsonObject, listPostponedWaitingBetIds } from "@/src/services/settlement/flashscore/observation-store";

const log = createLogger("settlement-manual");

const MANUAL_SETTLEMENT_LIMIT = 500;

/**
 * Por que a aposta está na fila: o que o automático fez com ela. Os campos do
 * FlashScore são os da última observação gravada (`null` quando ele não olhou).
 */
export type ManualSettlementCause =
  | { kind: "inferred_kickoff" }
  | { kind: "unconfirmed_sport" }
  | { kind: "flashscore_refused"; settlementOutcome: string | null }
  | { kind: "stalled"; flashscoreOutcome: string | null; settlementOutcome: string | null };

export type SettlementManualRow = {
  betId: string;
  evento: string;
  esporte: string;
  pais: string;
  competicao: string;
  mercado: string;
  selecao: string;
  odds: number;
  stake: number;
  data: Date;
  tipster: string;
  bankrollNome: string;
  bankrollSlug: string;
  /** A versão exibida: a liquidação da fila só vale se a aposta não mudou desde então. */
  manualSettlementVersion: number;
  cause: ManualSettlementCause;
};

/**
 * Apostas PENDING que o automático não vai liquidar. A fila segue o estado do
 * automático, não o mercado nem a identidade sharp: o FlashScore liquida por
 * nome qualquer mercado a partir de kickoff+90 min, e o IA-Judge entra às 6 h.
 * - Na hora: o FlashScore viu o jogo acabar e parou sem liquidar (placar
 *   gravado como evidência da recusa, ou observação do jogo casado fechada).
 *   O vínculo cedo do enrich não basta: no esporte que o FlashScore não
 *   liquida, a observação fecha a kickoff+90 min sem ver o fim, e o jogo
 *   vinculado espera as 6 h como os outros.
 * - Depois da janela de um jogo: esporte não confirmado, que nenhum
 *   liquidador automático pega.
 * - Sem horário (kickoff inferido), que nenhum liquidador pega: só depois de
 *   o jogo certamente ter acabado (`inferredGameOverAt`).
 * - Depois de 6 h: o resto, enquanto os retries seguem em segundo plano.
 * O jogo adiado fica fora nas 48 h em que o FlashScore espera a remarcação:
 * liquidar à mão seria anular um jogo que ainda pode acontecer.
 * A aposta com sugestão do IA-Judge pendente fica só em Homologar; quem lê as
 * duas filas descarta antes as sugestões desatualizadas.
 */
export async function getSettlementManual(now: Date = new Date()): Promise<SettlementManualRow[]> {
  const staleCutoff = judgeKickoffWindow(now).maxKickoff;
  const gameOverCutoff = new Date(now.getTime() - JANELA_DE_JOGO_MS);
  const rows = await prisma.bet.findMany({
    where: {
      deletedAt: null,
      status: "PENDING",
      data: { lt: now },
      id: { notIn: await listPostponedWaitingBetIds(now) },
      judgeSuggestions: { none: { status: "PENDING" } },
      OR: [
        {
          kickoffInferido: false,
          OR: [
            { result: { is: { scoreHome: { not: null } } } },
            {
              result: {
                is: {
                  resultFinal: true,
                  resultMatchId: { not: null },
                  resultSnapshot: { path: ["outcome"], equals: "matched" },
                },
              },
            },
            { sportResolutionStatus: { not: "CONFIRMED" }, data: { lte: gameOverCutoff } },
            { data: { lte: staleCutoff } },
          ],
        },
        // Corte largo: o fim do jogo sem horário é `inferredGameOverAt`, abaixo.
        { kickoffInferido: true, data: { lte: gameOverCutoff } },
      ],
    },
    // O jogo mais antigo primeiro; o id desempata apostas do mesmo horário.
    orderBy: [{ data: "asc" }, { id: "asc" }],
    // Uma a mais só para saber se a fila passou do limite.
    take: MANUAL_SETTLEMENT_LIMIT + 1,
    select: {
      id: true,
      evento: true,
      esporte: true,
      pais: true,
      competicao: true,
      mercado: true,
      selecao: true,
      odds: true,
      stake: true,
      data: true,
      tipster: true,
      kickoffInferido: true,
      registradoEm: true,
      sourcePostedAt: true,
      liveScoreHome: true,
      liveScoreAway: true,
      sportResolutionStatus: true,
      manualSettlementVersion: true,
      result: { select: { scoreHome: true, resultFinal: true, resultMatchId: true, resultSnapshot: true } },
      bankroll: { select: { nome: true, slug: true } },
    },
  });
  // Acima do limite, as apostas mais recentes ficariam invisíveis sem sinal. O
  // alerta tem dedupe de 10 min, então recarregar a página não o repete.
  if (rows.length > MANUAL_SETTLEMENT_LIMIT) {
    log.warn({ limit: MANUAL_SETTLEMENT_LIMIT }, "card de settlement manual truncado");
    await sendOperationalAlert(
      `📚 Fila de liquidação manual cheia\nHá mais de ${MANUAL_SETTLEMENT_LIMIT} apostas esperando, e o painel mostra só as mais antigas.\n👉 Liquide as mais antigas primeiro.`,
      {
        source: "painel.settlement-manual",
        key: "card-truncado",
        title: "Card de settlement manual truncado",
        resource: "settlement-manual",
        autoResolve: true,
      },
    ).catch((err) => log.error({ err }, "falha ao alertar truncamento do card manual"));
  }
  return rows.slice(0, MANUAL_SETTLEMENT_LIMIT).filter((b) => !b.kickoffInferido || inferredGameOverAt(b) <= now).map((b) => ({
    betId: b.id,
    evento: b.evento,
    esporte: b.esporte,
    pais: b.pais,
    competicao: b.competicao,
    mercado: b.mercado,
    selecao: b.selecao,
    odds: toNumber(b.odds),
    stake: toNumber(b.stake),
    data: b.data,
    tipster: b.tipster,
    bankrollNome: b.bankroll.nome,
    bankrollSlug: b.bankroll.slug,
    manualSettlementVersion: b.manualSettlementVersion,
    cause: manualSettlementCause(b),
  }));
}

const DAY_MS = 86_400_000;

/**
 * Quando o jogo sem horário certamente acabou. Na tip ao vivo a bola rolava no
 * post, então o jogo acaba uma janela de jogo depois dele. Na outra, o apito
 * mais tardio possível é o fim do dia do jogo em São Paulo ou uma janela de
 * jogo desde o post, o que vier depois, e o jogo dura até uma janela depois
 * desse apito.
 */
function inferredGameOverAt(bet: Omit<EntradaAoVivoParams, "kickoff"> & { data: Date }): Date {
  const entrada = { ...bet, kickoff: bet.data };
  const enteredAt = instanteDaEntrada(entrada).getTime();
  if (entrouAoVivo(entrada)) return new Date(enteredAt + JANELA_DE_JOGO_MS);
  const endOfDay = spStartOfTodayUtc(bet.data).getTime() + DAY_MS;
  return new Date(Math.max(endOfDay, enteredAt + JANELA_DE_JOGO_MS) + JANELA_DE_JOGO_MS);
}

function manualSettlementCause(bet: {
  kickoffInferido: boolean;
  sportResolutionStatus: string;
  result: { scoreHome: number | null; resultFinal: boolean; resultMatchId: string | null; resultSnapshot: unknown } | null;
}): ManualSettlementCause {
  if (bet.kickoffInferido) return { kind: "inferred_kickoff" };
  if (bet.sportResolutionStatus !== "CONFIRMED") return { kind: "unconfirmed_sport" };
  const snapshot = jsonObject(bet.result?.resultSnapshot);
  const settlementOutcome = typeof snapshot?.settlementOutcome === "string" ? snapshot.settlementOutcome : null;
  const flashscoreOutcome = typeof snapshot?.outcome === "string" ? snapshot.outcome : null;
  const refused = bet.result !== null && (bet.result.scoreHome !== null ||
    (bet.result.resultFinal && bet.result.resultMatchId !== null && flashscoreOutcome === "matched"));
  if (refused) return { kind: "flashscore_refused", settlementOutcome };
  return { kind: "stalled", flashscoreOutcome, settlementOutcome };
}
