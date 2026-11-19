import dominio from "@automabaca/dominio";
import { computeLucroFromStatus } from "@/src/domain/lucro";
import { statusFromAdjustedQuarters, extractSignedNumbers, parseLineQuarters, withoutNumberedHalf } from "./lines";
import { classifyScoreMarket, declaredScorePeriod } from "./markets";
import { matchTeamSide, resolveSideFromMarketAndSelection, stripTeamNames } from "./sides";
import { totalDirectionOf } from "@/src/domain/mercados/total-direction";
import { selecaoNomeiaTimeDoTotal } from "@/src/domain/mercados/selection-shape";
import { normalizeStr } from "@/src/domain/text";
import type { BetStatus } from "@/src/domain/bet-status";

export type MatchStatisticPair = { home: number; away: number };

/**
 * Linhas de estatística que o settlement sabe ler. As três primeiras são as
 * históricas e mantêm o NOME em `resultSnapshot` — snapshot antigo continua
 * legível, só não traz as chaves novas.
 */
export const MATCH_STATISTIC_KEYS = [
  "corners",
  "yellowCards",
  "redCards",
  "shotsTotal",
  "shotsOnTarget",
  "fouls",
  "offsides",
  "saves",
  "interceptions",
  "clearances",
  "assists",
  "blocks",
  "steals",
  "turnovers",
  "rebounds",
  "aces",
  "doubleFaults",
  "threePointers",
] as const;

export type MatchStatisticKey = (typeof MATCH_STATISTIC_KEYS)[number];

export type MatchStatistics = Partial<
  Record<MatchStatisticKey, MatchStatisticPair | null>
>;

export type StatisticResolutionFailure =
  | "unsupported_market"
  | "wrong_period"
  | "missing_stat"
  | "missing_line"
  | "invalid_line"
  | "ambiguous_selection"
  | "invalid_stake"
  | "invalid_odds";

export type StatisticFamily =
  | "corners"
  | "booking_points"
  | "yellow_cards"
  | "red_cards"
  | "shots_total"
  | "shots_on_target"
  | "fouls"
  | "offsides"
  | "saves"
  | "interceptions"
  | "clearances"
  | "assists"
  | "blocks"
  | "steals"
  | "turnovers"
  | "rebounds"
  | "aces"
  | "double_faults"
  | "three_pointers";

export type StatisticResolution =
  | {
      ok: true;
      status: BetStatus;
      lucro: number;
      statistic: StatisticFamily;
      values: MatchStatisticPair;
    }
  | { ok: false; reason: StatisticResolutionFailure };

/**
 * Família da linha, ou `null` quando o texto não nomeia uma estatística que o
 * settlement saiba ler. A regra mora em Rust
 * (`rust/crates/dominio/src/settlement/statistics.rs`).
 *
 * EXPORTADO porque é a fonte do roteamento, não só da resolução: o portão que
 * decide se vale gastar a chamada de estatística do FlashScore
 * (`marketNeedsFlashscoreStats`) deriva daqui, para as duas listas não
 * divergirem em silêncio.
 */
export function statisticFamilyOf(
  market: string,
  selection: string,
  evento?: string,
  esporte?: string,
): StatisticFamily | null {
  // O esporte `null` conta como informado (e desconhecido), como no
  // `!== undefined` da prop de jogador.
  const sport = esporte === undefined ? undefined : (esporte ?? "");
  return dominio.statisticFamilyOf(market, selection, evento, sport) as StatisticFamily | null;
}

/** Unidade declarada no texto; sujeito e período são validados pelo chamador. */
export function statisticFamilyInText(rawText: string): StatisticFamily | null {
  return dominio.statisticFamilyInText(rawText) as StatisticFamily | null;
}

/** A linha do feed de cada família; `booking_points` soma amarelos e vermelhos. */
const STAT_KEY_DA_FAMILIA: Readonly<Record<Exclude<StatisticFamily, "booking_points">, MatchStatisticKey>> = {
  corners: "corners",
  yellow_cards: "yellowCards",
  red_cards: "redCards",
  shots_total: "shotsTotal",
  shots_on_target: "shotsOnTarget",
  fouls: "fouls",
  offsides: "offsides",
  saves: "saves",
  interceptions: "interceptions",
  clearances: "clearances",
  assists: "assists",
  blocks: "blocks",
  steals: "steals",
  turnovers: "turnovers",
  rebounds: "rebounds",
  aces: "aces",
  double_faults: "doubleFaults",
  three_pointers: "threePointers",
};

export function valuesForFamily(
  family: StatisticFamily,
  stats: MatchStatistics,
): MatchStatisticPair | null {
  if (family === "booking_points") return bookingPoints(stats);
  return stats[STAT_KEY_DA_FAMILIA[family]] ?? null;
}

function bookingPoints(stats: MatchStatistics): MatchStatisticPair | null {
  if (!stats.yellowCards) return null;
  const reds = stats.redCards ?? { home: 0, away: 0 };
  return {
    home: stats.yellowCards.home + 2 * reds.home,
    away: stats.yellowCards.away + 2 * reds.away,
  };
}

export function isBothTeamsCards(market: string, selection: string): boolean {
  return dominio.isBothTeamsCards(market, selection);
}

/**
 * Linha colocada no fim do rótulo pela captura ("Total Corners 9.5").
 *
 * Não passamos o mercado inteiro ao parser: números do nome da estatística ou
 * do período não são linha. Em particular, "Total de Cestas de 3" não pode
 * virar Over 3 só porque a seleção contém "Over".
 */
function statisticMarketLineText(
  mercado: string,
  evento: string,
  statistic: StatisticFamily,
): string {
  const text = withoutNumberedHalf(stripTeamNames(mercado, evento)).trim();
  if (
    statistic === "three_pointers" &&
    /\b(?:cestas?|arremessos?)\s+de\s+3\s*$/.test(text)
  ) {
    return "";
  }
  return text.match(
    /(?:^|[\s(])([+−–—-]?\s*\d+(?:[.,]\d+)?(?:\s*[,/]\s*[+−–—-]?\s*\d+(?:[.,]\d+)?)?)\s*[\])}]?\s*$/,
  )?.[1] ?? "";
}

/** Uma estatística só não prova duas condições; conectivos de nomes e do rótulo saem antes. */
function hasCombinedStatisticConditions(text: string, evento: string): boolean {
  const terms = stripTeamNames(normalizeStr(text), evento)
    .replace(/\b(?:over|under|mais|menos|acima|abaixo)\s*(?:[/|~-]|ou|or)\s*(?:over|under|mais|menos|acima|abaixo)\b/g, " ")
    .replace(/\b(?:ou mais|or more|no minimo|at least)\b/g, " ")
    .replace(/\bcom\s+(?:prorrogacao|prolongamento|ot|overtime)\b/g, " ");
  return /\S\s*[&;|]\s*\S|\S\s+(?:e|and|y|ou|or|with|com)\s+\S|\S\s*\/\s*(?=[a-z])|(?:[^\d\s]\s*|\S\s+)\+\s*(?=[a-z])/.test(terms);
}

export function resolveResultFromStatistics(params: {
  mercado: string;
  selecao: string;
  evento: string;
  odds: number;
  stake: number;
  stats: MatchStatistics;
  statsPeriod?: "FT" | "HT" | "SECOND_HALF";
}): StatisticResolution {
  const { mercado, selecao, evento, odds, stake, stats } = params;
  if (!Number.isFinite(stake) || stake <= 0) return { ok: false, reason: "invalid_stake" };
  if (!Number.isFinite(odds) || odds <= 1) return { ok: false, reason: "invalid_odds" };
  const expectedPeriod = params.statsPeriod ?? "FT";
  const declaredPeriod = declaredScorePeriod({ mercado, selecao });
  if (declaredPeriod !== expectedPeriod) {
    return { ok: false, reason: "wrong_period" };
  }

  if ([mercado, selecao].some((text) => hasCombinedStatisticConditions(text, evento))) {
    return { ok: false, reason: "unsupported_market" };
  }
  const statistic = statisticFamilyOf(mercado, selecao, evento);
  if (!statistic) return { ok: false, reason: "unsupported_market" };
  const values = valuesForFamily(statistic, stats);
  if (!values) return { ok: false, reason: "missing_stat" };

  const marketN = normalizeStr(mercado);
  const selectionN = normalizeStr(selecao);
  const lineText = withoutNumberedHalf(stripTeamNames(selecao, evento));
  const marketKind = classifyScoreMarket(marketN, selectionN, evento);
  const isSpread = marketKind === "handicap";
  const isTeamTotal = marketKind === "team_total";
  const selectionNumbers = extractSignedNumbers(lineText);
  const marketLineText = statisticMarketLineText(mercado, evento, statistic);
  const lineQ = parseLineQuarters(lineText, { allowNegative: isSpread })
    // Número inválido na seleção é evidência conflitante, não autorização para
    // ignorá-lo e escolher a linha do mercado.
    ?? (selectionNumbers.length === 0
      ? parseLineQuarters(marketLineText, { allowNegative: isSpread })
      : null);
  if (lineQ === null) {
    return {
      ok: false,
      reason:
        selectionNumbers.length > 0 || extractSignedNumbers(marketLineText).length > 0
          ? "invalid_line"
          : "missing_line",
    };
  }

  // A convenção interna de cartões é CONTAGEM asiática (amarelo=1, vermelho=2).
  // Mercados de "booking POINTS" (amarelo=10, vermelho=25 — linhas 25/35/45+)
  // usam outra unidade: 3 amarelos + 1 vermelho = 55 pontos mas 5 na contagem.
  // Liquidar "Over 35.5 pontos" com a contagem seria LOST automático.
  // Recusa quando o texto declara pontos OU quando a linha é
  // implausível para contagem de cartões (≥15 — jogos raramente passam de 12).
  if (statistic === "booking_points") {
    const combined = normalizeStr(`${mercado} ${selecao}`);
    const declaresPoints = /\b(points?|pontos?|pts)\b/.test(combined);
    const lineImplausibleForCount = lineQ >= 15 * 4;
    if (declaresPoints || lineImplausibleForCount) {
      return { ok: false, reason: "unsupported_market" };
    }
  }

  let adjustedQ: number;
  if (["booking_points", "yellow_cards", "red_cards"].includes(statistic) && isBothTeamsCards(mercado, selecao)) {
    const direction = totalDirectionOf(selectionN);
    let status: BetStatus;
    if (direction) {
      const outcomes = [values.home, values.away].map((value) => statusFromAdjustedQuarters(
        direction === "over" ? 4 * value - lineQ : lineQ - 4 * value));
      // É um combinado: uma devolução ou meia vitória exige a odd paga pela casa.
      if (outcomes.some((outcome) => outcome !== "WON" && outcome !== "LOST")) {
        return { ok: false, reason: "unsupported_market" };
      }
      status = outcomes.every((outcome) => outcome === "WON") ? "WON" : "LOST";
    } else {
      if (/\b(?:over|under|mais|menos|acima|abaixo|above|below)\b/.test(
        selectionN.replace(/\b(?:ou mais|or more|no minimo|at least)\b/g, " "))) {
        return { ok: false, reason: "ambiguous_selection" };
      }
      if (lineQ <= 0 || lineQ % 4 !== 0) return { ok: false, reason: "invalid_line" };
      const minimum = lineQ / 4;
      status = values.home >= minimum && values.away >= minimum ? "WON" : "LOST";
    }
    return {
      ok: true,
      status,
      lucro: computeLucroFromStatus({ status, stake, odds, currentLucro: 0 }),
      statistic,
      values,
    };
  } else if (isSpread) {
    // Mesmo guard do handicap por placar: sem ele o rótulo do mercado seria
    // ignorado, e "Away AH Corners" com o mandante nomeado liquidaria pelo
    // lado da casa.
    const side = resolveSideFromMarketAndSelection(mercado, selecao, evento).side;
    if (!side) return { ok: false, reason: "ambiguous_selection" };
    const difference = side === "home" ? values.home - values.away : values.away - values.home;
    adjustedQ = 4 * difference + lineQ;
  } else {
    const direction = totalDirectionOf(selectionN, { allowBarePositiveLine: true });
    if (!direction) return { ok: false, reason: "ambiguous_selection" };
    // Duas fontes para o lado, como no placar: decidir pelo texto concatenado
    // deixaria o NOME vencer o rótulo ("Home Corners" com o visitante nomeado
    // liquidaria pelos cantos do visitante).
    //
    // E `isTeamTotal` exige a palavra "total", que a casa raramente escreve em
    // estatística: "Away Corners / Over 4.5" somaria os cantos DOS DOIS times.
    // Aqui a unidade JÁ é uma estatística, então rótulo com lado é team total
    // por construção. O time nomeado na seleção também: `isTeamTotal` recusa
    // o prefixo quando a seleção traz a unidade ("Flamengo mais de 4.5
    // escanteios"), e a soma pagaria os escanteios do adversário.
    const lado = resolveSideFromMarketAndSelection(mercado, selecao, evento);
    if (lado.contradicts) return { ok: false, reason: "ambiguous_selection" };
    const porTime = isTeamTotal || matchTeamSide(mercado, evento) !== null || selecaoNomeiaTimeDoTotal(selecao, evento);
    const side = porTime ? lado.side : null;
    if (porTime && !side) return { ok: false, reason: "ambiguous_selection" };
    const total = side === "home"
      ? values.home
      : side === "away"
        ? values.away
        : values.home + values.away;
    const totalQ = 4 * total;
    adjustedQ = direction === "over" ? totalQ - lineQ : lineQ - totalQ;
  }

  const status = statusFromAdjustedQuarters(adjustedQ);
  return {
    ok: true,
    status,
    lucro: computeLucroFromStatus({ status, stake, odds, currentLucro: 0 }),
    statistic,
    values,
  };
}
