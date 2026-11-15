import { isBttsMarket, isCombinedBttsMarket, isDoubleChanceMarket, isDrawNoBetMarket, isMethodOfVictoryMarket, isOutrightMarket, isRaceToMarket, isTeamTotalMarket, isThreeWayHandicapMarket, marketPeriodOf } from "@/src/domain/mercados/classify";
import { totalDirectionOf } from "@/src/domain/mercados/total-direction";
import { MATCH_SCOPE_NOUNS } from "@/src/domain/mercados/match-scope";
import {
  hasNonScoreStatQualifier,
  hasScoreUnitMismatch,
  hasUnknownScoreQualifier,
} from "@/src/domain/mercados/stat-qualifier";
import { lineSubjectIsNotEventTeam } from "@/src/domain/settlement/over-under-subject";
import { matchTeamSide, moneylineSelectionAsksAnotherMarket, stripTeamNames } from "@/src/domain/settlement/sides";
import { normalizeStr, splitEventoTeams } from "@/src/domain/text";

/**
 * Classificação de mercado para resolução por placar.
 *
 * BTTS e team totals usam `homeScore`/`awayScore` (gols por time) — o feed já
 * entrega o par, não só o agregado. Com kinds próprios, resolvem
 * deterministicamente. Props de jogador ficam fora
 * (`hasNonScoreStatQualifier` / unsupported).
 */

export type ScoreMarketKind =
  | "handicap"
  | "total"
  | "team_total"
  | "btts"
  | "moneyline"
  | "draw_no_bet"
  | "double_chance";

export { hasNonScoreStatQualifier, hasScoreUnitMismatch, hasUnknownScoreQualifier };

type MarketFamily = "total" | "btts" | "result" | "handicap";

const FAMILY_VOCABULARY: Readonly<Record<MarketFamily, RegExp>> = {
  total: /\b(?:over|under|acima|abaixo|above|below|total|totais)\b|\b(?:mais|menos)\s+(?:de|que)\b|\b[ou]\s?\d+[.,]\d/,
  btts: /\b(?:ambas|ambos|btts|both teams)\b/,
  result: /\b(?:vence\w*|vitoria|ganha\w*|wins?|winner|empat\w+|draw|money\s*line|ml|dnb|resultado|1x2)\b/,
  handicap: /\b(?:handicap|hcp|ah|spread)\b|(?:^|[\s([])[+-]\d/,
};

/** O que a seleção de cada mercado pode trazer sem pedir uma segunda condição. */
const OWN_FAMILIES: Readonly<Record<ScoreMarketKind, readonly MarketFamily[]>> = {
  handicap: ["handicap"],
  total: ["total"],
  team_total: ["total"],
  btts: ["btts"],
  moneyline: ["result"],
  draw_no_bet: ["result"],
  double_chance: ["result"],
};

/** Conectivo que junta duas pernas; o símbolo só antes de palavra, para "2.5/3", "0,-0.5" e "+0.5" seguirem linha. */
const LEG_CONNECTIVE = /\s(?:e|and|y|com|with)\s|[+&/,;|]\s*(?=[a-z])/g;

/**
 * Famílias de mercado das pernas que um conectivo junta no texto ("Sim e Over
 * 2.5", "Flamengo e Over 2.5", "Resultado / Total de Gols"). Sem conectivo não
 * há segunda perna. O conectivo dentro do nome de um time do evento ("Brighton
 * & Hove Albion") não separa nada, e o time sozinho numa perna é o resultado.
 */
function joinedLegFamilies(textN: string, evento?: string): Set<MarketFamily> {
  const teams = evento ? splitEventoTeams(evento) : null;
  const teamWords = teams
    ? [teams.home, teams.away].map((team) => new Set(normalizeStr(team).match(/[a-z0-9]+/g) ?? []))
    : [];
  const parts: string[] = [];
  let start = 0;
  for (const match of textN.matchAll(LEG_CONNECTIVE)) {
    const before = textN.slice(0, match.index).match(/[a-z0-9]+(?=[^a-z0-9]*$)/)?.[0] ?? "";
    const after = textN.slice(match.index + match[0].length).match(/[a-z0-9]+/)?.[0] ?? "";
    if (teamWords.some((words) => words.has(before) && words.has(after))) continue;
    parts.push(textN.slice(start, match.index));
    start = match.index + match[0].length;
  }
  const families = new Set<MarketFamily>();
  if (parts.length === 0) return families;
  parts.push(textN.slice(start));
  for (const part of parts) {
    const leg = evento ? stripTeamNames(part, evento) : part;
    if (evento && /[a-z]/.test(part) && !/[a-z0-9]/.test(leg) && matchTeamSide(part, evento)) families.add("result");
    for (const family of Object.keys(FAMILY_VOCABULARY) as MarketFamily[]) {
      if (FAMILY_VOCABULARY[family].test(leg)) families.add(family);
    }
  }
  return families;
}

/**
 * Família do mercado, ou null quando o placar não o responde sozinho: sem
 * motor para ele, ou com uma segunda condição que o rótulo ou a seleção juntam
 * ("Ambas Marcam" / "Sim e Over 2.5"). Pago por uma metade, o combinado sairia
 * ganho com a outra perdida.
 */
export function classifyScoreMarket(
  mercadoN: string,
  selecaoN: string,
  evento?: string,
): ScoreMarketKind | null {
  const kind = classifySingleMarket(mercadoN, selecaoN, evento);
  if (!kind) return null;
  if (joinedLegFamilies(mercadoN, evento).size > 1) return null;
  if ([...joinedLegFamilies(selecaoN, evento)].some((family) => !OWN_FAMILIES[kind].includes(family))) return null;
  if (kind === "moneyline" && moneylineSelectionAsksAnotherMarket(selecaoN, evento)) return null;
  return kind;
}

function classifySingleMarket(
  mercadoN: string,
  selecaoN: string,
  evento?: string,
): ScoreMarketKind | null {
  if (isOutrightMarket(mercadoN) || isMethodOfVictoryMarket(mercadoN)) return null;
  // Placar exato depende do placar selecionado, não apenas do vencedor. Ainda
  // não há resolver dessa família: falha fechada em vez de cair no termo amplo
  // "resultado" da moneyline e gerar ambiguous_selection a cada cron.
  if (/\b(?:resultado\s+exato|placar\s+exato|correct\s+score)\b/.test(mercadoN)) {
    return null;
  }
  // Handicap EUROPEU (3-way, linha inteira) NÃO é asiático: não tem push — o
  // resultado EXATO na linha é PERDA, não reembolso — e não casa a matemática
  // asiática de 2 vias. Recusa → settlement manual. A
  // normalização mantém "European Handicap" distinto de "Asian Handicap".
  if (
    isThreeWayHandicapMarket(mercadoN) ||
    (/\b(europeu|european)\b/.test(mercadoN) && /\bhandicap\b/.test(mercadoN))
  ) {
    return null;
  }
  // "Race to N"/"Primeiro a N" não é over/under do agregado — sem resolver da
  // família, falha fechado antes de qualquer outro ramo.
  if (isRaceToMarket(mercadoN, selecaoN)) return null;
  // Antes de "total"/"moneyline": senão Team Total casaria como total de jogo
  // e liquidaria no agregado. Kind próprio usa o placar do lado certo
  // (homeScore ou awayScore).
  //
  // O combo (resultado ∧ ambas marcam) vem ANTES do BTTS puro: resolver só a
  // perna de "ambas marcam" pagaria a aposta com a outra metade por conferir.
  // O vocabulário das duas perguntas é um só (`isBttsMarket`).
  if (isCombinedBttsMarket(mercadoN)) return null;
  if (isBttsMarket(mercadoN)) {
    return "btts";
  }
  // Sem isto, um prefixo que não é o time cai em team_total e, se o caller
  // só negar o team_total, a linha vira total de JOGO e paga o placar.
  if (lineSubjectIsNotEventTeam(selecaoN, evento)) return null;
  if (isTeamTotalMarket(mercadoN, selecaoN, evento)) {
    return "team_total";
  }
  if (isDrawNoBetMarket(mercadoN)) {
    return "draw_no_bet";
  }
  if (isDoubleChanceMarket(mercadoN)) {
    return "double_chance";
  }
  // TOTAL antes de HANDICAP: "Asian Total"/"Asian Over/Under"/"Asian Goal Line"
  // contêm a palavra "asian" mas são TOTAIS (têm over/under). Se o handicap viesse
  // primeiro, a regex `\basian\b` os capturaria como handicap → matchTeamSide não
  // acharia lado → a aposta encalharia PENDING com alerta repetido. Handicap real
  // (linha por time, sem over/under) não casa o total e cai no ramo de baixo.
  const combined = `${mercadoN} ${selecaoN}`;
  const explicitSpreadMarket =
    /\b(handicap|ah|spread)\b/.test(mercadoN) || /\b(run|puck)\s*line\b/.test(mercadoN);
  const explicitTotalMarket =
    // `mais menos`/`acima abaixo` (a grafia "Mais/Menos" da casa) precisa estar
    // aqui também, senão o roteamento de preço vê total e o settlement devolve
    // `unsupported_market` para o mesmo rótulo.
    // O separador entra explícito porque `mercadoN` é `normalizeStr` (mantém a
    // pontuação), não `normalizeMercadoKey`.
    /\b(over|under|total|totais|mais\s*[/|-]?\s*menos|acima\s*[/|-]?\s*abaixo|mais\s*(?:de|que)|menos\s*(?:de|que)|acima(?:\s*de)?|abaixo(?:\s*de)?|goal\s*line|linha\s+de\s+(?:gols?|pontos?|runs?|corridas?)|asian\s+(?:corners?|escanteios?|cantos?|cards?|cartoes?|carteos?|bookings?|shots?)|escanteios?\s+asi[aá]ticos?|cantos?\s+asi[aá]ticos?|cart(?:[oõ]es?|eos)\s+asi[aá]ticos?)\b/i.test(mercadoN);
  // O texto da selecao pode conter palavras como "Over" dentro do nome de um
  // time. Um mercado explicitamente de handicap tem precedencia, salvo quando
  // o proprio mercado declara que e um total asiatico.
  if (explicitSpreadMarket && !explicitTotalMarket) return "handicap";
  if (
    explicitTotalMarket &&
    (
      totalDirectionOf(selecaoN, { allowBarePositiveLine: true }) ??
      totalDirectionOf(combined)
    )
  ) {
    return "total";
  }

  // `asian` sozinho é handicap — MENOS quando o próprio mercado declarou que é
  // total ("Asian Total"). Sem esta exceção, um total asiático cuja direção não
  // foi reconhecida cairia como handicap e seria resolvido com matemática
  // de linha por lado. Mercado que declara total permanece total; sem
  // direção ele falha fechado mais adiante, que é o lado seguro.
  if (/\basian\b/.test(mercadoN) && !explicitTotalMarket) {
    return "handicap";
  }

  const compact = mercadoN.replace(/[^a-z0-9]/g, "");
  // O escopo do "para vencer/ganhar" vem de `match-scope.ts`, o mesmo do filtro
  // SQL: se divergissem, "Para Ganhar o Confronto" sairia do IA-Judge sem log.
  const matchScope = MATCH_SCOPE_NOUNS.join("|");
  if (
    new RegExp(
      String.raw`\b(resultado\s*final|resultado\s*do\s*jogo|resultado|vencedor|ganhador|para\s+(?:vencer|ganhar)\s+(?:[ao]\s+)?(?:${matchScope})|quem\s+(?:vencera|vence|ganhara|ganha)|money\s*line|match\s*winner|full\s*time\s*result|1x2|winner|ml)\b`,
    ).test(mercadoN) ||
    /^(?:para\s+ganhar)$/.test(mercadoN) ||
    compact === "1x2" ||
    compact === "ml"
  ) {
    // Capturas antigas/reais podem manter o rótulo genérico "Moneyline" e
    // carregar a regra DNB apenas na seleção ("Time DNB"). Nesse caso a
    // semântica da seleção precisa vencer; `matchMoneylineSelection` recusa
    // DNB de propósito para nunca liquidá-lo como 1X2 comum.
    return isDrawNoBetMarket(selecaoN) ? "draw_no_bet" : "moneyline";
  }
  return null;
}

export function isScoreResolvableMarket(params: {
  mercado: string;
  selecao: string;
  esporte?: string;
  /** Sem evento o team total só é reconhecido na forma com PREFIXO. */
  evento?: string;
}): boolean {
  if (hasNonScoreStatQualifier(params.mercado, params.selecao)) return false;
  if (hasUnknownScoreQualifier(params.mercado)) return false;
  if (hasScoreUnitMismatch(params.mercado, params.selecao, params.esporte)) return false;
  // Esta pergunta é "o PLACAR FINAL responde?", e para 1º tempo/HT/mapa ele não
  // responde — quem usa isto (caixa de ações e lote do IA-Judge) só tem o
  // agregado. NÃO leia como "aposta de tempo não liquida": ela
  // liquida pelo caminho do FlashScore, que busca os parciais do jogo
  // (`soccerPeriodScores`) e resolve cada perna com o placar do SEU período.
  if (hasNonFullTimeScorePeriod(params)) return false;
  return (
    classifyScoreMarket(
      normalizeStr(params.mercado),
      normalizeStr(params.selecao),
      params.evento,
    ) !== null
  );
}

/** Mercado e seleção são duas superfícies da mesma evidência de período. */
export function hasNonFullTimeScorePeriod(params: {
  mercado: string;
  selecao: string;
  esporte?: string;
}): boolean {
  return declaredScorePeriod(params) !== "FT";
}

/**
 * Período efetivo das duas superfícies. FT numa delas é "não declarou";
 * conflito HT vs segundo tempo, OTHER ou MAP recusam liquidação automática.
 */
export function declaredScorePeriod(params: {
  mercado: string;
  selecao: string;
  esporte?: string;
}): ReturnType<typeof marketPeriodOf> {
  const mercadoPeriod = marketPeriodOf(params.mercado, params.esporte);
  const selecaoPeriod = marketPeriodOf(params.selecao, params.esporte);
  if (mercadoPeriod === "OTHER" || selecaoPeriod === "OTHER") return "OTHER";
  if (mercadoPeriod === "MAP" || selecaoPeriod === "MAP") return "MAP";
  if (
    mercadoPeriod !== "FT"
    && selecaoPeriod !== "FT"
    && mercadoPeriod !== selecaoPeriod
  ) {
    return "OTHER";
  }
  return mercadoPeriod !== "FT" ? mercadoPeriod : selecaoPeriod;
}
