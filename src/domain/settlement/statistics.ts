import { computeLucroFromStatus } from "@/src/domain/lucro";
import { statusFromAdjustedQuarters, extractSignedNumbers, parseLineQuarters, withoutNumberedHalf } from "./lines";
import { classifyScoreMarket, declaredScorePeriod } from "./markets";
import { matchTeamSide, resolveSideFromMarketAndSelection, stripTeamNames } from "./sides";
import { isRaceToMarket } from "@/src/domain/mercados/classify";
import { totalDirectionOf } from "@/src/domain/mercados/total-direction";
import { selecaoNomeiaTimeDoTotal } from "@/src/domain/mercados/selection-shape";
import {
  isBothTeamsCardsText,
  selecaoDeclaraLinhaDeEstatistica,
} from "@/src/domain/mercados/stat-qualifier";
import { lineSubjectIsNotEventTeam } from "./over-under-subject";
import { classificarPropDeJogador } from "./player-prop-classify";
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
 * Marca de prop de JOGADOR. A estatística do feed é sempre por TIME; usar essa
 * linha para uma prop individual é responder outra pergunta.
 */
const PROP_DE_JOGADOR =
  /\b(?:player|jogador|jogadora|atleta|scorer|artilheiro|marcador)\b/;

/** Marca a linha "no gol": é ela que separa chute de chute CERTO. */
const ON_TARGET_RE =
  /\b(?:on\s+(?:target|goal)|ao?\s+gol|no\s+gol|no\s+alvo|a\s+baliza|enquadradas?|enquadrados?|certas?|certos?)\b/;
/** Marca explícita de agregado — autoriza a linha de chutes TOTAIS. */
const TOTAL_SHOTS_RE =
  /\b(?:total|totais|todos|todas)\b/;

/**
 * Relações em que uma família é apenas a versão específica de outra. Fora
 * delas, mercado e seleção estão contradizendo a unidade e a resposta segura é
 * `null`, não escolher silenciosamente um dos dois textos.
 */
function familiaGenericaDe(family: StatisticFamily): StatisticFamily | null {
  switch (family) {
    case "yellow_cards":
    case "red_cards":
      return "booking_points";
    case "shots_on_target":
      return "shots_total";
    case "double_faults":
      return "fouls";
    default:
      return null;
  }
}

/**
 * Família da linha, ou `null` quando o texto não nomeia uma estatística que o
 * settlement saiba ler.
 *
 * EXPORTADO porque é a fonte do roteamento, não só da resolução: o portão que
 * decide se vale gastar a chamada de estatística do FlashScore
 * (`marketNeedsFlashscoreStats`) deriva daqui, para as duas listas não
 * divergirem em silêncio.
 *
 * A GUARDA sobre a seleção vive aqui para roteamento e resolução a herdarem:
 * sem ela, "Las Vegas Aces" (time da WNBA) viraria família `aces` num
 * moneyline e sairia do caminho de placar para morrer em manual.
 */
export function statisticFamilyOf(
  market: string,
  selection: string,
  evento?: string,
  esporte?: string,
): StatisticFamily | null {
  const marketN = normalizeStr(market);
  // Prop de JOGADOR não se resolve pela linha do TIME: 2 amarelos do time
  // pagariam "Player Cards / Over 0.5" de um jogador que talvez nem tenha
  // entrado. O caminho de placar já recusa isso (`hasNonScoreStatQualifier`); o resolver
  // de jogador lê `player-stats`. Sem casamento, a aposta fica manual — nunca
  // herda a soma do time.
  if (classificarPropDeJogador({ mercado: market, selecao: selection, evento, esporte })) {
    return null;
  }
  // Recusar classificar a prop não autoriza liquidar pelo time: o prefixo
  // que não é lado do evento não é estatística de equipe.
  if (lineSubjectIsNotEventTeam(selection, evento)) return null;
  if (PROP_DE_JOGADOR.test(normalizeStr(`${market} ${selection}`))) return null;
  // "Race to 3 Corners" / "First to 3 Corners" pergunta QUEM chega primeiro à
  // marca, não over/under da SOMA: "Race to 3 / Under 2.5" com 1-1 daria WON
  // pelo agregado 2. Não há resolver da família.
  if (isRaceToMarket(market, selection)) return null;
  const peloMercado = statisticFamilyInText(marketN);
  // Pela SELEÇÃO, só quando ela acopla o termo a uma linha. Nome de time não
  // declara mercado. Ela pode, porém, especializar uma família genérica do
  // mercado: amarelos/vermelhos, chutes no gol e duplas faltas são linhas
  // diferentes no feed e precisam vencer o rótulo-pai.
  const pelaSelecao = selecaoDeclaraLinhaDeEstatistica(selection)
    ? statisticFamilyInText(normalizeStr(selection))
    : null;
  if (!peloMercado) return pelaSelecao;
  if (!pelaSelecao || pelaSelecao === peloMercado) return peloMercado;
  if (familiaGenericaDe(pelaSelecao) === peloMercado) return pelaSelecao;
  // A seleção pode repetir o nome genérico de um mercado já específico sem
  // apagar a precisão declarada pelo próprio mercado.
  if (familiaGenericaDe(peloMercado) === pelaSelecao) return peloMercado;
  return null;
}

/** Unidade declarada no texto; sujeito e período são validados pelo chamador. */
export function statisticFamilyInText(rawText: string): StatisticFamily | null {
  const text = normalizeStr(rawText);
  if (/\b(corner|corners|escanteio|escanteios|canto|cantos)\b/.test(text)) return "corners";
  // Mercado que DECLARA a cor conta AQUELA cor. `booking_points` aplica a
  // fórmula asiática (amarelo=1, vermelho=2), então "Total Red Cards / Under
  // 1.5" com 1 vermelho e 1 amarelo daria 3 e LOST, quando a contagem
  // de vermelhos é 1 e a aposta ganha. A cor vem ANTES do genérico,
  // como "duplas faltas" vem antes de "faltas".
  if (/\b(?:red\s+cards?|cart(?:ao|oes)\s+vermelh[oa]s?|vermelh[oa]s?)\b/.test(text)) {
    return "red_cards";
  }
  if (/\b(?:yellow\s+cards?|cart(?:ao|oes)\s+amarel[oa]s?|amarel[oa]s?)\b/.test(text)) {
    return "yellow_cards";
  }
  if (/\b(card|cards|booking|bookings|cartao|cartoes|carteos)\b/.test(text)) return "booking_points";
  // ANTES de `fouls`: "duplas faltas" contém "faltas" e cairia na família
  // errada — o tênis liquidaria pela linha de faltas do futebol, que nem existe
  // na resposta. Termo composto sempre vence o genérico que ele contém.
  if (/\b(dupla falta|duplas faltas|double fault|double faults)\b/.test(text)) {
    return "double_faults";
  }
  if (/\b(falta|faltas|foul|fouls)\b/.test(text)) return "fouls";
  if (/\b(offside|offsides|impedimento|impedimentos)\b/.test(text)) return "offsides";
  if (/\b(defesa|defesas|save|saves)\b/.test(text)) return "saves";
  // CHUTES: "Total de Finalizações" e "Finalizações no Gol" são LINHAS
  // DIFERENTES do feed, e liquidar uma pela outra é dinheiro invertido. Só
  // resolve quando o texto declara qual das duas quer; "chutes" solto fica
  // `unsupported_market` e vai para o operador.
  if (/\b(chute|chutes|shot|shots|finalizacao|finalizacoes|remate|remates)\b/.test(text)) {
    if (ON_TARGET_RE.test(text)) return "shots_on_target";
    if (TOTAL_SHOTS_RE.test(text)) return "shots_total";
    return null;
  }
  // Famílias que o feed publica em inteiro puro (conferido por varredura do
  // feed), e por isso resolvem direto sem IA-Judge nem operador.
  if (/\b(interception|interceptions|interceptacao|interceptacoes)\b/.test(text)) {
    return "interceptions";
  }
  if (/\b(clearance|clearances|corte|cortes|afastamento|afastamentos)\b/.test(text)) {
    return "clearances";
  }
  if (/\b(assistencia|assistencias|assist|assists)\b/.test(text)) return "assists";
  if (/\b(bloqueio|bloqueios|block|blocks|toco|tocos)\b/.test(text)) return "blocks";
  if (/\b(roubo|roubos|roubada|roubadas|steal|steals)\b/.test(text)) return "steals";
  if (/\b(turnover|turnovers|perda|perdas)\b/.test(text)) return "turnovers";
  if (/\b(rebote|rebotes|rebound|rebounds)\b/.test(text)) return "rebounds";
  if (/\b(ace|aces)\b/.test(text)) return "aces";
  // CESTA DE TRÊS. O feed publica `3-point field goals made`: aceita o hífen
  // do fornecedor e a forma natural em PT ("Total de Cestas de 3").
  //
  // `triple`/`triplo` SOZINHO fica de fora: "Triple Double" é PROP DE JOGADOR
  // no basquete, e bastaria um número na seleção para liquidar pela linha
  // errada.
  if (
    /\b(?:3|three|tres)[\s-]*point/.test(text) ||
    /\bcestas? de (?:3|tres)\b/.test(text) ||
    /\barremessos? de (?:3|tres)\b/.test(text) ||
    // PLURAL em `triples`, pela mesma disciplina que `legs`/`frames` já seguem
    // no registro de esportes: o singular é outra coisa no vocabulário das
    // casas ("Triple Double"), o plural não.
    /\b(?:triplas?|triples)\b/.test(text)
  ) {
    return "three_pointers";
  }
  return null;
}

export function valuesForFamily(
  family: StatisticFamily,
  stats: MatchStatistics,
): MatchStatisticPair | null {
  switch (family) {
    case "corners":
      return stats.corners ?? null;
    case "booking_points":
      return bookingPoints(stats);
    case "yellow_cards":
      return stats.yellowCards ?? null;
    case "red_cards":
      return stats.redCards ?? null;
    case "shots_total":
      return stats.shotsTotal ?? null;
    case "shots_on_target":
      return stats.shotsOnTarget ?? null;
    case "fouls":
      return stats.fouls ?? null;
    case "offsides":
      return stats.offsides ?? null;
    case "saves":
      return stats.saves ?? null;
    case "interceptions":
      return stats.interceptions ?? null;
    case "clearances":
      return stats.clearances ?? null;
    case "assists":
      return stats.assists ?? null;
    case "blocks":
      return stats.blocks ?? null;
    case "steals":
      return stats.steals ?? null;
    case "turnovers":
      return stats.turnovers ?? null;
    case "rebounds":
      return stats.rebounds ?? null;
    case "aces":
      return stats.aces ?? null;
    case "double_faults":
      return stats.doubleFaults ?? null;
    case "three_pointers":
      return stats.threePointers ?? null;
  }
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
  return isBothTeamsCardsText(`${market} ${selection}`);
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
