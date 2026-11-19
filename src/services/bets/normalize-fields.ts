import { canonicalizeAsianHandicapSelecao } from "@/src/domain/asian-handicap-line";
import { looksLikeTotalSelection } from "@/src/domain/mercados/total-direction";
import type { BetLegsTicket } from "@/src/domain/bet-legs";
import { stripLiveScoreAtTip } from "@/src/domain/live-score-at-tip";
import { matchTeamSide } from "@/src/domain/settlement/sides";
import { normalizeStr, splitEventoTeams } from "@/src/domain/text";
import { declaresRegulationTime, marketIncludesExtraTime } from "@/src/domain/mercados/classify";
import { coerceMercadoPelaSelecao } from "@/src/domain/mercados/coerce";
import { marketSportOf, REGULATION_TIME_SPORTS, regulationTimeBaseOf } from "@/src/domain/mercados/compatibility";
import { regulationTimeMarket } from "@/src/domain/mercados/finalize";
import { moneylineSelectionUnreadable, pinnacleizeSelecao } from "@/src/domain/mercados/selecao";
import { normalizeMercado, type MercadoCatalogClient } from "@/src/services/mercados/normalize";

export type NormalizeBetFieldsInput = {
  evento: string;
  mercado: string;
  selecao: string;
  esporte: string;
  casaDeAposta?: string;
  /** Se false, não colapsa whitespace do evento (edit path já vem preparado). Default true. */
  normalizeEventoName?: boolean;
  /** Ticket com pernas: não reescrever a seleção concatenada. */
  preserveSelecao?: boolean;
  /**
   * Placar na hora da aposta, já estruturado. Escrito "1x2" na seleção, ele é
   * o placar, não o mercado 1X2.
   */
  liveScore?: { home: number; away: number } | null;
  client?: MercadoCatalogClient;
};

export type NormalizeBetFieldsResult = {
  evento: string;
  mercado: string;
  selecao: string;
  mercadoMatched: boolean;
  mercadoAliasConflict?: NonNullable<
    Awaited<ReturnType<typeof normalizeMercado>>["aliasConflict"]
  >;
};

function normalizeEvento(evento: string): string {
  return evento.replace(/\s+/g, " ").trim();
}

function teamStatSideFromRawMarket(rawMarket: string): "home" | "away" | null {
  const marketN = normalizeStr(rawMarket);
  if (!/\b(?:remates?|shots?|chutes?|finalizacoes?)\b/.test(marketN)) return null;
  const token = marketN.match(
    /\b(?:time|team|equipe)\s*(1|2|da casa|visitante|home|away)\b/,
  )?.[1];
  if (token) return /^(?:1|da casa|home)$/.test(token) ? "home" : "away";
  if (/\b(?:home(?:\s+team)?|casa)\b/.test(marketN)) return "home";
  if (/\b(?:away(?:\s+team)?|visitante)\b/.test(marketN)) return "away";
  return null;
}

/** Preserva o lado declarado no rótulo Bet365 antes de apagar o alias. */
function selectionWithTeamStatSide(params: {
  rawMarket: string;
  selection: string;
  evento: string;
}): string {
  const expectedSide = teamStatSideFromRawMarket(params.rawMarket);
  if (!expectedSide) return params.selection;
  const selectedSide = matchTeamSide(params.selection, params.evento);
  if (selectedSide && selectedSide !== expectedSide) {
    throw new Error(
      `Escopo conflitante em remates: mercado declara ${expectedSide === "home" ? "Time 1" : "Time 2"}, ` +
      `mas a seleção aponta o outro lado (${params.selection}).`,
    );
  }
  if (selectedSide) return params.selection;
  const teams = splitEventoTeams(params.evento);
  if (!teams) return params.selection;
  const team = expectedSide === "home" ? teams.home : teams.away;
  return `${team} ${params.selection}`;
}

/**
 * Total cujo time vem só no rótulo do mercado ("Total de gols - Flamengo" +
 * "Over 1.5"): o time passa para a seleção, e a coerção faz dele total do
 * time. Sem isso a aposta seria gravada e liquidada como total do jogo.
 */
function selectionWithMarketTeam(params: { rawMarket: string; selection: string; evento: string }): string {
  const { selection, evento } = params;
  if (!looksLikeTotalSelection(selection) || matchTeamSide(selection, evento)) return selection;
  const side = matchTeamSide(params.rawMarket, evento);
  const teams = splitEventoTeams(evento);
  if (!side || !teams) return selection;
  return `${side === "home" ? teams.home : teams.away} ${selection}`;
}

/**
 * Tira do texto o placar ao vivo já estruturado ("(1x2)", "1-2", nas duas
 * ordens), para ele não ser lido como o mercado 1X2 do tempo regulamentar.
 */
function withoutLiveScore(text: string, liveScore?: { home: number; away: number } | null): string {
  if (!liveScore) return text;
  const pairs = [[liveScore.home, liveScore.away], [liveScore.away, liveScore.home]];
  return pairs.reduce((current, [a, b]) => current.replace(
    new RegExp(String.raw`\(?(?<![\d.,])${a}\s*[x×:-]\s*${b}(?![\d.,])\)?`, "gi"),
    " ",
  ), text);
}

const EXTRA_TIME_SUFFIX = "incluindo prorrogação";

/** O rótulo recebido declarava a prorrogação e a normalização a apagou. */
function lostExtraTimeRule(
  raw: { mercado: string; selecao?: string },
  normalized: { mercado: string; selecao: string },
): boolean {
  return [raw.mercado, raw.selecao ?? ""].some(marketIncludesExtraTime) &&
    ![normalized.mercado, normalized.selecao].some(marketIncludesExtraTime);
}

/**
 * Pipeline canônico mercado×seleção (register + edit de canal).
 * Entry-point único — evita drift create×edit.
 */
export async function normalizeBetFields(
  input: NormalizeBetFieldsInput,
): Promise<NormalizeBetFieldsResult> {
  const normalized = await normalizeFields(input);
  // Na múltipla a regra vai em cada perna; a seleção do bilhete fica inteira.
  // Onde o mercado do jogo já inclui a prorrogação, declará-la não muda nada.
  if (input.preserveSelecao || REGULATION_TIME_SPORTS.has(marketSportOf(input.esporte)) ||
    !lostExtraTimeRule(input, normalized)) return normalized;
  // O mercado gravado é sempre o do catálogo. A regra segue na seleção, onde
  // o preço e a liquidação já a leem.
  return { ...normalized, selecao: `${normalized.selecao} ${EXTRA_TIME_SUFFIX}` };
}

async function normalizeFields(
  input: NormalizeBetFieldsInput,
): Promise<NormalizeBetFieldsResult> {
  const evento =
    input.normalizeEventoName === false
      ? input.evento
      : normalizeEvento(input.evento);

  // O mercado do tempo regulamentar não está no catálogo de aliases: ele se
  // renormaliza pela base de jogo inteiro e volta a ser regulamentar abaixo,
  // se o esporte (confirmado depois da captura) tiver prorrogação.
  const mercadoResult = await normalizeMercado(regulationTimeBaseOf(input.mercado) ?? input.mercado, {
    casaDeAposta: input.casaDeAposta || undefined,
    esporte: input.esporte,
    client: input.client,
  });
  const selectionWithSide = selectionWithMarketTeam({
    rawMarket: input.mercado,
    selection: selectionWithTeamStatSide({ rawMarket: input.mercado, selection: input.selecao, evento }),
    evento,
  });
  // O placar live é evidência estruturada da Bet, não parte da linha
  // financeira. Removê-lo antes da coerção impede `(1-0)` de interferir na
  // classificação e depois no lado/handicap.
  const selecaoSemPlacarLive = stripLiveScoreAtTip(selectionWithSide, mercadoResult.mercado);
  // Um alias ambíguo preserva o rótulo recebido. A seleção pode parecer AH,
  // mas isso não autoriza escolher a convenção financeira que o banco deixou
  // contraditória; a aposta fica PENDING e ganha ação operacional no writer.
  const mercado = mercadoResult.aliasConflict
    ? mercadoResult.mercado
    : regulationTimeMarket({
        mercado: coerceMercadoPelaSelecao(
          mercadoResult.mercado,
          selecaoSemPlacarLive,
          input.esporte,
          evento,
        ),
        selecao: selecaoSemPlacarLive,
        evento,
        esporte: input.esporte,
        declared: declaresRegulationTime(withoutLiveScore(input.mercado, input.liveScore)) ||
          declaresRegulationTime(withoutLiveScore(selecaoSemPlacarLive, input.liveScore)),
      });
  if (input.preserveSelecao) {
    return {
      evento,
      mercado,
      selecao: input.selecao.trim(),
      mercadoMatched: mercadoResult.matched,
      ...(mercadoResult.aliasConflict
        ? { mercadoAliasConflict: mercadoResult.aliasConflict }
        : {}),
    };
  }
  const selecaoFinanceira = selecaoSemPlacarLive;
  const selecaoRaw = pinnacleizeSelecao({
    selecao: selecaoFinanceira,
    mercadoPinnacle: mercado,
    evento,
    esporte: input.esporte,
  });
  const selecao = canonicalizeAsianHandicapSelecao(selecaoRaw, evento, mercado);

  return {
    evento,
    mercado,
    selecao,
    mercadoMatched: mercadoResult.matched && !moneylineSelectionUnreadable({ mercado, selecao, evento }),
    ...(mercadoResult.aliasConflict
      ? { mercadoAliasConflict: mercadoResult.aliasConflict }
      : {}),
  };
}

/** Pernas de múltipla no mesmo vocabulário, para create e edit persistirem igual. */
export async function normalizeTicketLegs(
  ticket: BetLegsTicket,
  esporte: string,
  casaDeAposta: string,
  client?: NormalizeBetFieldsInput["client"],
): Promise<BetLegsTicket> {
  const legs = [];
  for (const leg of ticket.legs) {
    const normalized = await normalizeFields({
      evento: leg.evento,
      mercado: leg.mercado,
      selecao: leg.selecao,
      esporte,
      casaDeAposta: casaDeAposta || undefined,
      client,
    });
    legs.push({
      evento: normalized.evento,
      // A liquidação da múltipla lê a regra no mercado de cada perna.
      mercado: lostExtraTimeRule(leg, normalized)
        ? `${normalized.mercado} ${EXTRA_TIME_SUFFIX}` : normalized.mercado,
      selecao: normalized.selecao,
    });
  }
  return { kind: ticket.kind, legs };
}
