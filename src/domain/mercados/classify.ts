import { canonicalSport } from "@/src/domain/sports/registry";
import { normalizeStr } from "@/src/domain/text";
import { matchTeamSide } from "@/src/domain/settlement/sides";
import { normalizeMercadoKey } from "./catalog";
import { doubleChancePattern, drawNoBetPattern } from "./draw-vocabulary";
import { MATCH_SCOPE_NOUNS } from "./match-scope";
import {
  SCORE_UNIT_RULES,
  selecaoDeclaraLinhaDeEstatistica,
} from "./stat-qualifier";
import { expandAbbreviatedDirection, totalDirectionOf } from "./total-direction";
import { trailingTeamCandidate, trailingTeamCandidateOfSelection } from "./trailing-side";

export type MarketKind =
  | "moneyline"
  | "total"
  | "spread"
  | "team_total"
  | "draw_no_bet"
  | "double_chance"
  | "btts"
  | "correct_score"
  | "scorer"
  | "player_props"
  | "other";

export type MarketPeriod = "FT" | "HT" | "SECOND_HALF" | "MAP" | "OTHER";

const TEAM_TOTAL_NAMED_UNIT_RE = new RegExp(
  `\\b(?:goals?|gols?|goal\\s*line|corners?|cantos?|escanteios?|cards?|cartoes?|carteos?|bookings?|${Object.values(
    SCORE_UNIT_RULES,
  ).flatMap((rule) => rule.terms).join("|")})\\b`,
);

export function isEsports(esporte: string | null | undefined): boolean {
  return normalizeStr(esporte ?? "").replace(/\s+/g, "") === "esports";
}

const MAP_ORDINAL: Record<string, number> = {
  primeiro: 1,
  primeira: 1,
  segundo: 2,
  segunda: 2,
  terceiro: 3,
  terceira: 3,
  quarto: 4,
  quarta: 4,
  quinto: 5,
  quinta: 5,
  "1o": 1,
  "1a": 1,
  "2o": 2,
  "2a": 2,
  "3o": 3,
  "3a": 3,
  "4o": 4,
  "4a": 4,
  "5o": 5,
  "5a": 5,
};

const MAP_ROMAN: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
};

/**
 * Número do mapa em eSports (Map 1 / primeiro mapa). Null = não é mercado por mapa.
 * O número do mapa permanece distinto do período de jogo completo.
 */
export function marketMapNumberOf(
  mercado: string,
  esporte?: string | null,
): number | null {
  const key = normalizeMercadoKey(mercado);
  if (!key) return null;
  const numbered = key.match(/\b(?:map|mapa)\s*(\d+)\b/);
  if (numbered?.[1]) {
    const n = Number(numbered[1]);
    return n >= 1 && n <= 9 ? n : null;
  }
  const roman = key.match(/\b(?:map|mapa)\s+(i|ii|iii|iv|v)\b/);
  if (roman?.[1]) return MAP_ROMAN[roman[1]] ?? null;
  // "1º mapa" → normalizeMercadoKey vira "1 mapa" (º some).
  const digitFirst = key.match(/\b([1-9])\s+mapa\b/);
  if (digitFirst?.[1]) return Number(digitFirst[1]);
  const englishOrdinal = key.match(/\b([1-9])(?:st|nd|rd|th)\s+(?:map|mapa)\b/);
  if (englishOrdinal?.[1]) return Number(englishOrdinal[1]);
  const ordinal = key.match(
    /\b(primeiro|primeira|segundo|segunda|terceiro|terceira|quarto|quarta|quinto|quinta|1o|1a|2o|2a|3o|3a|4o|4a|5o|5a)\s+mapa\b/,
  );
  if (ordinal?.[1]) return MAP_ORDINAL[ordinal[1]] ?? null;
  const compact = key.match(/\bm([1-9])\b/);
  if (compact?.[1]) return Number(compact[1]);
  // "Game/Jogo N" também nomeia mapa em eSports, mas não globalmente:
  // em tênis/baseball é uma unidade diferente e precisa continuar fail-closed.
  if (isEsports(esporte)) {
    const game = key.match(/\b(?:game|jogo)\s*([1-9])\b/);
    if (game?.[1]) return Number(game[1]);
  }
  return null;
}

/** Qualificadores financeiros compartilhados pela captura e pelos contratos de preço. */
export const EXTRA_TIME_PATTERN = /\bot included\b|\b(?:including|includes|incl|incluindo|inclui|incluir|inclusa|incluso|incluid[ao]|com)\.?\s+(?:ot|overtime|extra time|prorrogacao|prolongamento)\b/;
export const REGULATION_TIME_PATTERN = /\b1\s*x\s*2\b|\b(?:3|tres|three)[\s-]*(?:vias?|way)\b|\btempo\s+(?:regular|regulamentar|normal)\b|\bregulamentar\b|\bregular\s+time\b|\bregulation(?:\s+time)?\b|\(\s*tr\s*\)/;

/** Declaração explícita de que a prorrogação conta no resultado. */
export function marketIncludesExtraTime(mercado: string): boolean {
  return EXTRA_TIME_PATTERN.test(normalizeMercadoKey(mercado));
}

/** Lê antes da normalização de mercado, que apaga os parênteses de "(TR)". */
export function declaresRegulationTime(text: string): boolean {
  return !marketIncludesExtraTime(text) && REGULATION_TIME_PATTERN.test(normalizeStr(text));
}

/**
 * Vocabulário ÚNICO de "ambas marcam". Existiam DUAS listas para a mesma
 * pergunta — uma em `marketKindOf` (roteamento de odds) e outra em
 * `classifyScoreMarket` (settlement) — e elas já divergiam: só a segunda
 * conhecia `gol/gol`, só a primeira conhecia `ambas as equipes marcarao`.
 * Uma grafia precificável mas não liquidável (ou o inverso)
 * é a assinatura desse tipo de divergência.
 */
const BTTS_MARKET_RE =
  /\bboth teams to score\b|\bboth score\b|\bbtts\b|\bambas (?:as )?equipes marcam\b|\bambas marcam\b|\bambos marcam\b|\bambas as equipes marcarao\b|\bambos os times marcarao\b|\bpara ambos marcarem\b|\bgol gol\b/;

/** As frases de BTTS de um texto, para apagar todas e ler o que sobra. */
const BTTS_MARKET_ALL = new RegExp(BTTS_MARKET_RE, "g");
const BTTS_RESIDUE_NAMES_MARKET =
  /\b(?:1x2|resultado|result|winner|vencedor|vencedora|vence|vencer|venca|win|wins|ganha|ganhador|empate|draw|over|under|mais|menos|acima|abaixo|total|totais|handicap|spread|escanteios?|corners?|cartoes|carteos|cards?)\b/;

export function isBttsMarket(mercado: string): boolean {
  return BTTS_MARKET_RE.test(normalizeMercadoKey(mercado));
}

/**
 * O pedido em CADA tempo: "nos dois tempos", "em cada tempo", "both halves", ou
 * o 1º e o 2º tempo nomeados juntos ("no 1º e no 2º tempo", "1T e 2T", "1st
 * and 2nd half", "PT e ST"). Gol, vitória ou ambas marcam nos dois tempos
 * exigem a condição em cada tempo, e nenhum placar sozinho responde: o Over
 * 0.5 com o intervalo 0-0 e o 2º tempo 1-0 perde. Lido pelos tempos que
 * nomeia, o texto seria só do 2º tempo.
 */
const EACH_HALF =
  /\b(?:(?:dois|2|ambos(?: os)?|os dois) tempos|cada tempo|(?:duas|2|ambas(?: as)?) (?:etapas|metades)|cada etapa|(?:both|two|2) halves|each half)\b/;
const BOTH_HALVES_ELIDED =
  /\b(?:1|1o|1a|1st|primeir[oa]|first) (?:e|and) (?:(?:no|na|o|a|the) )?(?:(?:2|2o|2a|2nd|segund[oa]|second) (?:tempos?|etapas?|partes?|metades?|halves|half)|2t)\b|\bpt (?:e )?st\b/;

function namesBothHalves(key: string): boolean {
  return EACH_HALF.test(key) || BOTH_HALVES_ELIDED.test(key) ||
    (FIRST_HALF_MENTION.test(key) && SECOND_HALF_MENTION.test(key));
}

/** O texto pede os DOIS tempos ("nos dois tempos", "Both Halves", "1º e 2º tempo"). */
export function marketNamesBothHalves(text: string): boolean {
  return namesBothHalves(halfAwareKey(text));
}

/**
 * BTTS COMBINADO com outra perna ("Casa vence e ambas marcam", "BTTS & Over
 * 2.5"). Não é um BTTS: exige as DUAS condições, e resolver só a perna de
 * "ambas marcam" paga a aposta ignorando a outra metade — num 1-1 o combo
 * "casa vence e ambas marcam" saía WON com a casa não tendo vencido.
 *
 * A detecção é por RESÍDUO: apaga a frase de BTTS e pergunta se o que sobrou
 * ainda nomeia um mercado. Assim "Ambas Marcam – Jogo" continua BTTS puro e
 * qualquer combinação nova (resultado, total, handicap) nasce recusada, sem
 * depender de alguém lembrar de escrever a grafia do combo. O BTTS em cada
 * tempo também exige duas condições.
 */
export function isCombinedBttsMarket(mercado: string): boolean {
  const key = halfAwareKey(mercado);
  if (!BTTS_MARKET_RE.test(key)) return false;
  if (namesBothHalves(key)) return true;
  return BTTS_RESIDUE_NAMES_MARKET.test(key.replace(BTTS_MARKET_ALL, " "));
}

/**
 * "no" é preposição em PT colado ao verbo ("Ambas marcam no 1º tempo",
 * "marcarão no jogo", "marcam gol no jogo") ou antes do nome do jogo
 * ("Gol/Gol no jogo"). Em qualquer outro lugar é o Não: "BTTS No FT", "Ambas
 * Marcam - No (FT)", "Ambas marcam no". "match" fica fora dos nomes do jogo:
 * "BTTS No Match" é o Não em inglês.
 */
const BTTS_VERB_PREPOSITION = /\b(marca(?:m|r|rem|rao)?(?:\s+gols?)?)\s+no(?=\s+[a-z0-9])/g;
const MATCH_SCOPE_PREPOSITION = new RegExp(
  String.raw`\bno(?=\s+(?:${MATCH_SCOPE_NOUNS.filter((noun) => noun !== "match").join("|")})\b)`,
  "g",
);
/**
 * Antes de um tempo, por extenso ou sigla, e longe do verbo, o "no" pode ser
 * um ou outro: "Gol/Gol no 1T" é o Sim, e "BTTS No 1T" pode ser o Não. Só o
 * espaço separa os dois; com pontuação no meio ("BTTS - No - 1T", "BTTS No
 * (1T)") o "No" é a seleção. Roda sobre o texto que ainda tem a pontuação.
 */
function isNoBeforeHalf(text: string): boolean {
  for (const match of text.matchAll(/\bno\s+(?=[a-z0-9])/g)) {
    if (HALF_MENTION_AT_START.test(halfAwareKey(text.slice(match.index + match[0].length)))) return true;
  }
  return false;
}

/**
 * O "No" maiúsculo colado ao verbo e antes de um tempo ("Ambas marcam No FT",
 * "Ambas Marcam No 1T") pode ser o Não da casa ou a preposição, como o "no"
 * solto antes do tempo. Lê a grafia original, que a chave minúscula apaga.
 */
function isCapitalNoAfterVerbBeforeHalf(selecao: string): boolean {
  const text = selecao.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(BTTS_VERB_PREPOSITION)) {
    const end = match.index + match[0].length;
    if (text[end - 2] !== "N") continue;
    const after = lower.slice(end).trimStart();
    if (/^(?:ft|full time)\b/.test(after) || HALF_MENTION_AT_START.test(halfAwareKey(after))) return true;
  }
  return false;
}

/**
 * Lado da seleção de "ambas marcam", lido num lugar só pela captura (Yes/No)
 * e pela liquidação. Sim junto com negação, o BTTS combinado com outra perna
 * ou em cada tempo, o "no" que pode ser preposição e a frase com um
 * qualificador que ela não conhece não decidem (null).
 */
export function bttsSelectionSide(selecao: string): "yes" | "no" | null {
  if (isCapitalNoAfterVerbBeforeHalf(selecao)) return null;
  // As preposições saem antes da chave, que apagaria o hífen de "Marcam - No".
  const text = normalizeStr(selecao)
    .replace(BTTS_VERB_PREPOSITION, "$1")
    .replace(MATCH_SCOPE_PREPOSITION, " ");
  const key = halfAwareKey(text);
  if (!key || isCombinedBttsMarket(key) || namesBothHalves(key)) return null;
  const spelledNo = /\b(?:nao|not|ng)\b|\bsem gols? de ambos\b/.test(key);
  const bareNo = /\bno\b/.test(key);
  if (bareNo && !spelledNo && isNoBeforeHalf(text)) return null;
  const affirmed = /\b(?:sim|yes|gg)\b|^g g$/.test(key);
  if (spelledNo || bareNo) return affirmed ? null : "no";
  if (affirmed || /^(?:ambas|ambos)$/.test(key) || bttsPhraseAlone(key)) return "yes";
  return null;
}

/**
 * Sem Sim escrito, a frase só vale como Sim acompanhada do escopo ("no jogo")
 * ou de um tempo só, que o período da seleção já lê. Qualquer outra sobra
 * pode mudar o mercado e vai para manual.
 */
function bttsPhraseAlone(key: string): boolean {
  if (!BTTS_MARKET_RE.test(key)) return false;
  return key.replace(BTTS_MARKET_ALL, " ").replace(BTTS_FILLER, " ").trim() === "";
}

/**
 * "Race to N" / "Primeiro a N" — quem CHEGA primeiro à marca, com void quando
 * ninguém chega. Não é over/under do agregado, e era assim que liquidava:
 * "Race to 3 Corners / Under 2.5" com 1-1 devolvia WON pela soma.
 * Não há resolver dessa família — falha fechado.
 */
export function isRaceToMarket(mercado: string, selecao = ""): boolean {
  const key = normalizeMercadoKey(`${mercado} ${selecao}`);
  return /\b(?:race to|first to|primeiro a|corrida ate|corrida a)\b/.test(key);
}

/** Handicap de três vias/europeu não compartilha a mecânica asiática de push. */
export function isThreeWayHandicapMarket(mercado: string): boolean {
  const key = normalizeMercadoKey(mercado);
  const hasScoreNotation = /\b\d+\s*:\s*\d+\b/.test(normalizeStr(mercado));
  return (
    (/\bhandicap\b/.test(key) &&
      // `europeo` (ES) junto de `europeu`/`european`: sem ele o handicap
      // europeu em espanhol era tratado como asiático e a cobertura exata
      // virava PUSH/VOID, quando no europeu de 3 vias ela é derrota.
      (/\b(?:3\s*way|three\s*way|3\s*vias?|3\s*(?:opcoes|selecoes)|europeu|european|europeo|europea|europeen|europeenne)\b/.test(key) ||
        hasScoreNotation)) ||
    /\b(?:handicap\s+result|handicap\s+resultado|resultado\s+(?:do\s+|(?:final\s+)?com\s+)?handicap)\b/.test(key)
  );
}

/**
 * Escopo de outright: o que se vence NÃO é a partida. Exportado como dado
 * porque o filtro SQL precisa da mesma lista — "Quem Vencerá o Campeonato"
 * era recusado pelo domínio e aceito pelo SQL, saindo do IA-Judge.
 */
export const OUTRIGHT_SCOPE_NOUNS = [
  "torneio", "campeonato", "grupo", "trofeu", "competicao", "liga", "serie",
  // O PRÊMIO também nomeia o escopo: "Vencedor do Título"/"Quem Vencerá a
  // Taça"/"Vencedor da Copa" eram classificados como MONEYLINE e passavam em
  // `isScoreResolvableMarket` — uma aposta de campeonato liquidava pelo placar
  // de UMA partida. O par (verbo, escopo) segue exigido: "Copa"
  // sozinha no nome do mercado não exclui nada.
  "titulo", "taca", "copa",
  // A FASE e a TEMPORADA são escopo pela mesma razão; "medalha" cobre
  // o vocabulário olímpico e "qualificacao" o de classificação.
  "fase", "premio", "medalha", "temporada", "qualificacao",
  // EN: os feeds nomeiam o escopo ANTES de "winner" ("Group Stage Winner"),
  // forma que a lista PT não alcançava.
  "group stage", "group", "season", "conference", "playoff", "playoffs",
  "division", "tournament", "championship", "cup", "trophy", "title", "medal",
  "qualification", "qualifier",
] as const;
export const OUTRIGHT_WINNER_PHRASES = [
  "quem vence", "quem ganha", "quem leva", "vencedor", "vencedora",
  "ganhador", "ganhadora", "campeao", "campea",
  "para vencer", "para ganhar", "to win the", "to lift", "winner",
] as const;

const OUTRIGHT_SCOPE = OUTRIGHT_SCOPE_NOUNS.join("|");
const OUTRIGHT_MARKET = new RegExp(
  // `(?:${OUTRIGHT_SCOPE})\s+winners?` é a ordem EN (escopo ANTES do verbo); a ordem PT
  // usa preposição. As duas leem a MESMA lista.
  String.raw`\b(?:outrights?|futures?|to\s+lift|to\s+win\s+the|(?:${OUTRIGHT_SCOPE})\s+winners?|winner\s+of\s+the\s+(?:${OUTRIGHT_SCOPE})|campe(?:ao|a|oes|as)|vencedor(?:a)?\s+final|(?:vencedor(?:a)?|ganhador(?:a)?|campe(?:ao|a))\s+d[oa]\s+(?:${OUTRIGHT_SCOPE})|para\s+(?:vencer|ganhar)\s+(?:(?:o|a)\s+)?(?:${OUTRIGHT_SCOPE})|quem\s+(?:vencera|vence|ganhara|ganha|leva)\s+(?:(?:o|a)\s+)?(?:${OUTRIGHT_SCOPE}))\b`,
);

/** Outrights/futures não representam o vencedor da partida corrente. */
export function isOutrightMarket(mercado: string): boolean {
  return OUTRIGHT_MARKET.test(normalizeMercadoKey(mercado));
}

/** Método da vitória não equivale ao vencedor da partida. */
export function isMethodOfVictoryMarket(mercado: string): boolean {
  const key = normalizeMercadoKey(mercado);
  return /\b(?:ko|tko|submissions?|decisions?|metodo|methods?|(?:vencedor(?:a)?|vitoria|vence)\s+por\s+(?:nocaute|finalizacao|submissao|decisao|pontos)|method of victory|winning method|victory method|metodo da vitoria|metodo de vitoria|metodo (?:do|de) encerramento|forma da vitoria|forma de vitoria|modo da vitoria|modo de vitoria|tipo da vitoria|tipo de vitoria|tipo da finalizacao|tipo de finalizacao|como (?:o|a) (?:combate|luta|duelo|confronto) (?:vai )?terminara?|como termina (?:o|a) (?:combate|luta|duelo|confronto)|metodo (?:de|do|da) (?:desfecho|termino|encerramento|finalizacao)|modo (?:de|do|da) (?:desfecho|termino|finalizacao))\b/.test(
    key,
  );
}

const DRAW_NO_BET_MARKET_RE = new RegExp(`\\b${drawNoBetPattern()}\\b`);
const DOUBLE_CHANCE_MARKET_RE = new RegExp(`\\b${doubleChancePattern()}\\b`);

/** Vocabulário único de Draw No Bet (dados em `draw-vocabulary.ts`). */
export function isDrawNoBetMarket(mercado: string): boolean {
  return DRAW_NO_BET_MARKET_RE.test(normalizeMercadoKey(mercado));
}

/** Vocabulário único de Dupla Chance, incluindo siglas/labels legados. */
export function isDoubleChanceMarket(mercado: string): boolean {
  return DOUBLE_CHANCE_MARKET_RE.test(normalizeMercadoKey(mercado));
}

const TOTAL_LABEL = /\b(?:total|totais|over|under|mais menos|acima abaixo)\b/;
const TOTAL_LABEL_WORDS = /\b(?:total|totais|over|under|mais|menos|acima|abaixo|time|team|equipe)\b/g;

/**
 * Lado do evento que o RÓTULO de um total nomeia ("Total de Gols do Vasco",
 * "Vasco - Total de Gols", "Total Gols Time Visitante"). A seleção desses
 * mercados é só "Over 1.5": lido como total do jogo, o placar somado pagaria
 * a aposta no time que não marcou.
 */
export function totalLabelSide(mercado: string, evento: string): "home" | "away" | null {
  const key = normalizeMercadoKey(mercado);
  if (!TOTAL_LABEL.test(key) || /\b(?:handicap|spread|ah)\b/.test(key)) return null;
  const named = trailingTeamCandidate(key.replace(TOTAL_LABEL_WORDS, " "));
  return named ? matchTeamSide(named, evento) : null;
}

/**
 * Team total aparece tanto no mercado quanto na seleção. Alguns feeds enviam
 * `Total Goals` + `Flamengo Over 1.5`; outros usam `Home Total Goals` com a
 * seleção genérica. Esta é a fonte única usada por settlement e coverage.
 */
export function isTeamTotalMarket(
  mercado: string,
  selecao = "",
  evento?: string,
): boolean {
  const marketKey = normalizeMercadoKey(mercado);
  if (
    /\b(?:points?|pontos?|runs?|corridas?)\s+(?:do\s+time|da\s+equipe)\b/.test(
      marketKey,
    ) ||
    /\bteam\s*total\b|\btotal\s*(?:(?:de\s+gols\s+)?(?:do\s+time|da\s+equipe)|(?:de\s+gols\s+)?por\s+(?:time|equipe))\b/.test(
      marketKey,
    ) ||
    /\btotal\s+(?:(?:de\s+)?(?:goals?|gols?|points?|pontos?|corners?|cantos?|escanteios?|cards?|cartoes?|carteos?|bookings?)\s+)?(?:(?:do|da|de)\s+)?(?:home|away|casa|fora|mandante|visitante)\b/.test(
      marketKey,
    ) ||
    /\b(?:home|away|casa|fora|mandante|visitante)(?:\s+team)?\s+(?:(?:goals?|points?|pontos?|corners?|cantos?|escanteios?|cards?|cartoes?|carteos?|bookings?)\s+)?total(?:\s+(?:goals?|points?|pontos?|corners?|cantos?|escanteios?|cards?|cartoes?|carteos?|bookings?))?\b/.test(
      marketKey,
    ) ||
    // "Home Team Goals" sem a palavra `total` é a grafia comum da casa e caía em
    // `unsupported_market`. O lado + a unidade já declaram o mercado.
    /\b(?:home|away|casa|fora|mandante|visitante)(?:\s+team)?\s+(?:goals?|gols?|points?|pontos?)\b/.test(
      marketKey,
    )
  ) {
    return true;
  }
  if (evento && totalLabelSide(mercado, evento)) return true;
  // Só uma variante com unidade explícita autoriza inferir pelo nome na seleção.
  // `Total`/`Total – Match` canônico pode carregar o time apenas como ruído
  // legado e continua sendo agregado (regressão dos clubes com número no nome).
  // `gols` (PT) precisa estar na lista como "goals" (EN): sem ele, "Total de
  // Gols" + "Time Over 1.5" cairia em total de JOGO e liquidaria pelo placar
  // agregado — 0x3 daria WON para uma aposta no time que não marcou.
  if (!TEAM_TOTAL_NAMED_UNIT_RE.test(marketKey)) return false;

  // "Flamengo O 4.5" nomeia o time como "Flamengo Over 4.5", e "Escanteios O
  // 7.5" declara a estatística como "Escanteios Over 7.5".
  const expandedSelection = expandAbbreviatedDirection(selecao);
  const selectionKey = normalizeMercadoKey(expandedSelection);
  const namedBeforeDirection = selectionKey.match(
    /^(.+?)\s+\b(?:over|under|mais\s+de|menos\s+de|acima(?:\s+de)?|abaixo(?:\s+de)?)\b/,
  )?.[1]?.trim();
  if (
    namedBeforeDirection &&
    /[a-z]/.test(namedBeforeDirection) &&
    // "Cartões Amarelos Over 1.5" nomeia uma subfamília, não um time. Sem
    // esta trava o refinamento correto da estatística virava team total sem
    // lado e terminava em `ambiguous_selection`.
    !selecaoDeclaraLinhaDeEstatistica(expandedSelection)
  ) return true;

  // O time também vem DEPOIS da linha ("Over 1.5 Gols do Flamengo"). Tratada
  // como total de JOGO, essa forma liquidaria pelo placar agregado: 0x3 daria
  // WON para quem apostou no time que não marcou.
  // Sem o evento não dá para separar nome de time de ruído de unidade/período,
  // e chutar ali transformaria "Over 9.5 corners 1st half" em total por equipe:
  // sem o evento, só a forma com PREFIXO é team total.
  if (!evento) return false;
  const trailing = trailingTeamCandidateOfSelection(selecao);
  return Boolean(trailing && matchTeamSide(trailing, evento));
}

/**
 * Combo que exige OS DOIS placares (intervalo E final). Precisa ser testado
 * ANTES do vocabulário de meio-tempo: com "intervalo"/"1st half" no SSOT de
 * fase parcial, "Resultado Intervalo/Final" e "1st Half / Full Time" seriam
 * classificados como HT — recusa certa pelo motivo errado. E `Resultado Duplo`
 * / `Resultado 1T/Final` nem eram detectados: caíam em FT e liquidavam pelo
 * placar final 1X2.
 */
const COMBO_HT_FT =
  /\b(?:half\s*time\s*full\s*time|ht\s*ft|h5\s*ft|intervalo\s*(?:e\s*)?final|resultado\s+duplo|(?:1t|1o tempo|primeiro tempo|1st half|half time|first half)\s*(?:e|\/)?\s*(?:final|full\s*time|ft)\b)/;

/**
 * Frases de meio-tempo, como DADO. O filtro SQL precisa das MESMAS: ele negava
 * "segundo tempo" e "1º" mas não "2 tempo"/"2o tempo"/"primeiro tempo", então
 * uma aposta de 2º tempo entrava no lote determinístico (que a recusa pelo
 * período) e, como o IA-Judge seleciona pelo `NOT` do filtro, ficava sem
 * NENHUM liquidador automático. As siglas (HT/H1/2H…) continuam na
 * regex porque exigem limite de token, e no SQL têm filtro próprio.
 */
export const HALF_PERIOD_PHRASES = {
  first: [
    "1st half", "first half", "half time", "halftime",
    "1o tempo", "1 tempo", "primeiro tempo",
    // "Intervalo" e "Meio Tempo" são as formas BR mais comuns, e "1ª Parte"
    // perde o ordinal na normalização (vira "1 parte"). Sem elas o mercado cai
    // em FT e LIQUIDA PELO PLACAR DE 90 MINUTOS: "Intervalo - Totais" /
    // "Over 0.5" com jogo 2-0 (HT 0-0) daria WON.
    "intervalo", "meio tempo", "1 parte", "primeira parte",
    // "Etapa" é o sinônimo BR de tempo mais usado por narração/tipster; sem
    // ele "2ª Etapa Totais" liquidaria pelo placar de 90 minutos. "1ª" perde o
    // ordinal na normalização e vira "1"; "1a" digitado com letra sobrevive.
    // As duas grafias precisam estar aqui, como "1o tempo"/"1 tempo".
    "1 etapa", "1a etapa", "primeira etapa",
    "primeira metade", "1 metade",
  ],
  second: [
    "2nd half", "second half", "2o tempo", "2 tempo", "segundo tempo",
    "2 parte", "segunda parte", "2 etapa", "2a etapa", "segunda etapa",
    "segunda metade", "2 metade",
  ],
} as const;

/**
 * Siglas compactas de meio-tempo. Ficam FORA de `HALF_PERIOD_PHRASES` porque o
 * espelho SQL gera `contains` da frase: "1t" como substring pegaria lixo.
 * O filtro de lote usa `PARTIAL_PHASE_ABBREVIATIONS` (token com espaços).
 * `1T/FT` continua combo: `COMBO_HT_FT` roda ANTES destas regex.
 */
export const HALF_PERIOD_ABBREVIATIONS = {
  first: ["ht", "h1", "1h", "fh", "1t"],
  second: ["h2", "2h", "sh", "2t"],
} as const;

const FIRST_HALF_MENTION = new RegExp(
  String.raw`\b(?:${[...HALF_PERIOD_PHRASES.first, ...HALF_PERIOD_ABBREVIATIONS.first].join("|")})\b`,
);
const SECOND_HALF_MENTION = new RegExp(
  String.raw`\b(?:${[...HALF_PERIOD_PHRASES.second, ...HALF_PERIOD_ABBREVIATIONS.second].join("|")})\b`,
);
/** Um tempo no começo da chave; "tempo" sozinho ("no tempo regulamentar") conta. */
const HALF_MENTION_AT_START = new RegExp(
  String.raw`^(?:tempo|${[
    ...HALF_PERIOD_PHRASES.first, ...HALF_PERIOD_ABBREVIATIONS.first,
    ...HALF_PERIOD_PHRASES.second, ...HALF_PERIOD_ABBREVIATIONS.second,
  ].join("|")})\b`,
);

/** O que pode acompanhar a frase de BTTS sem mudar o mercado (`bttsPhraseAlone`). */
const BTTS_FILLER = new RegExp(
  String.raw`\b(?:${[
    ...MATCH_SCOPE_NOUNS, "no", "na", "em", "o", "a", "in", "the", "ft", "full time",
    ...HALF_PERIOD_PHRASES.first, ...HALF_PERIOD_PHRASES.second,
    ...HALF_PERIOD_ABBREVIATIONS.first, ...HALF_PERIOD_ABBREVIATIONS.second,
  ].join("|")})\b`,
  "g",
);

/**
 * Chave de mercado que lê a sigla do tempo. O ordinal colado de "1ºT"/"2°T"
 * vira espaço na chave ("1 t") e não casaria a sigla "1t"; cola antes de
 * normalizar. "1º Tempo" não muda: o `t` não termina ali, e a frase "1 tempo"
 * o cobre.
 */
function halfAwareKey(text: string): string {
  return normalizeMercadoKey(text.replace(/(\d)\s*[ºª°]\s*t\b/gi, "$1t"));
}

/**
 * "PT"/"ST" só valem logo depois da linha, no fim do texto ("Over 0.5 PT",
 * "Flamengo -0.5 ST"): em qualquer posição, "St" de St Pauli/St Mirren
 * viraria segundo tempo.
 */
const TRAILING_HALF_AFTER_LINE = { first: /\b\d+\s+(?:gols?\s+)?pt$/, second: /\b\d+\s+(?:gols?\s+)?st$/ };

/** Esportes jogados em dois tempos, em que as siglas soltas PT/ST são o 1º e o 2º tempo. */
const TWO_HALVES_SPORTS: ReadonlySet<string> = new Set(["Soccer", "Futsal", "Handball"]);

/**
 * Em outro esporte as siglas não se presumem ("Over 110.5 PT" no basquete pode
 * ser de pontos). Esporte que o registro não conhece (vazio, "Unknown") vale
 * como no futebol.
 */
function readsTrailingHalfAbbreviation(esporte: string | null | undefined): boolean {
  const sport = canonicalSport(esporte);
  return sport === null || TWO_HALVES_SPORTS.has(sport);
}

/**
 * Janela de minutos ("0-10 min", "até 15 min", "primeiros 10 minutos") não é
 * tempo nenhum: nem o placar do 1º tempo nem o final a respondem.
 * `minutos` antes de `min`: com `min` primeiro, o `\b` do fim caía dentro de
 * "minutos".
 */
const MINUTE_WINDOW = /\b\d{1,3}\s*(?:minutos?|minutes?|mins?|min)\b/;

export function marketPeriodOf(
  mercado: string,
  esporte?: string | null,
): MarketPeriod {
  const key = halfAwareKey(mercado);
  // Cada tempo não tem placar próprio, nem com a prorrogação declarada.
  if (namesBothHalves(key)) return "OTHER";
  // Mercados que DECLARAM incluir prorrogação usam o placar final listado.
  // A exceção precisa vir antes do bloqueio de "overtime/extra time" abaixo.
  if (marketIncludesExtraTime(mercado)) return "FT";
  // Resultado combinado intervalo/final exige os dois placares; não é HT.
  // Precisa vir ANTES do bloco de meio-tempo: com "intervalo" agora no
  // vocabulário de 1º tempo, "Resultado Intervalo/Final" seria classificado
  // como HT e recusado pelo motivo errado — quando na verdade ele não resolve
  // por placar nenhum isolado.
  if (COMBO_HT_FT.test(key)) {
    return "OTHER";
  }
  // Sem um placar específico da fase, regulamentar/prorrogação/pênaltis não
  // podem usar o agregado final do provider.
  if (
    // "90 minutos" é o tempo regulamentar, e cai em `MINUTE_WINDOW`.
    // `aet` compacto ficava de fora: `\bet\b` não casa dentro de "aet", então
    // "AET Winner" caía em FT e liquidava pelo placar do provider enquanto o
    // irmão "After Extra Time Winner" recusava. O rótulo é ambíguo
    // entre "o período da prorrogação" e "o agregado depois dela"; quem quer o
    // agregado escreve "incluindo/including", que `marketIncludesExtraTime`
    // captura ACIMA. Sem essa palavra, é decisão humana.
    MINUTE_WINDOW.test(key) ||
    /\b(?:regulation|tempo regulamentar|extra time|overtime|prorrogacao|prolongamento|penaltis?|penalties|penalty|shootout|shoot out|disputa de penaltis|aet|et|ot|pen|so)\b/.test(
      key,
    )
  ) {
    return "OTHER";
  }
  // Quartos, períodos e innings são unidades parciais. Inclui abreviações dos
  // catálogos (Q1/P1) e a grafia PT cujo ordinal perde o símbolo na normalização.
  if (/\b(?:quarters?|quartos?|q\s*[1-9]|[1-9]\s*q|p\s*[1-9]|[1-9]\s*p|periods?|periodos?)\b/.test(key)) {
    return "OTHER";
  }
  if (
    /\b(?:innings?\s*[1-9]|i\s*[1-9]|[1-9](?:st|nd|rd|th)?\s+innings?|[1-9]\s+entradas?|f\s*5|h\s*5)\b/.test(key)
  ) {
    return "OTHER";
  }
  // Game/Jogo N só equivale a mapa quando o contexto confirma eSports. Em
  // tênis/baseball permanece unidade interna e não usa o agregado do provider.
  if (/\b(?:game|jogo)\s*[1-9]\b/.test(key)) {
    return marketMapNumberOf(mercado, esporte) === null ? "OTHER" : "MAP";
  }
  if (/\b(?:set|round|frame|leg|points)\s+winner\b/.test(key)) return "OTHER";
  // `game winner` EM INGLÊS fica de fora de propósito: nos esportes americanos
  // "game" É a partida (contrato fixado em `tests/identidade/mercados-taxonomy.test.ts`).
  // Em PT a palavra só é usada com o sentido de tênis —
  // "Vencedor do Game" é a unidade interna, e ali o placar em SETS não responde.
  // O esporte é o discriminador real, e ele não chega aqui em todos
  // os caminhos; a forma PT é a parte inequívoca.
  if (/\b(?:vencedor|ganhador) d[oa] (?:game|set|round|frame|leg)\b/.test(key)) return "OTHER";
  // O pistol round (o primeiro de cada metade do mapa) e o round com ordinal
  // por extenso também são de dentro do mapa ou da luta.
  if (/\bpistol\b|\b(?:primeir[oa]|segund[oa]|ultim[oa]|first|second|last)\s+round\b/.test(key)) return "OTHER";
  // Sets, rounds, frames e legs também são unidades internas. As formas S1/R1
  // aparecem em feeds que colocam o número antes do nome da fase. O compacto
  // BR `1S` (espelho de `1T`) cairia no default FT ("1S Totais" / "Over 1.5"
  // com jogo 3-0 daria WON). `1st half` não casa: o `t` quebra o `\b` depois
  // do `s`.
  if (
    /\b(?:s\s*[1-9]|[1-9]\s*s|r\s*[1-9]|(?:set|round|frame|leg)\s*[1-9]|[1-9](?:st|nd|rd|th)?\s+(?:set|round|frame|leg))\b/.test(
      key,
    )
  ) return "OTHER";
  // `1 tempo` sem o "o" existe porque `normalizeMercadoKey` troca tudo que não
  // é [a-z0-9] por espaço: o ordinal masculino de "1º Tempo" some e o texto
  // vira "1 tempo". Sem esta forma, aposta de 1º tempo seria classificada como
  // FT e LIQUIDARIA PELO PLACAR DE 90 MINUTOS ("1º Tempo - Totais" / "Over 1.5"
  // com jogo 3-0 e HT 0-0 daria WON). O mesmo vale para `1T`/`2T` compactos,
  // no mercado ("1T Totais") ou na seleção ("Over 1.5 1T").
  const trailingHalf = readsTrailingHalfAbbreviation(esporte);
  if (
    SECOND_HALF_MENTION.test(key) ||
    (trailingHalf && TRAILING_HALF_AFTER_LINE.second.test(key))
  ) {
    return "SECOND_HALF";
  }
  if (
    FIRST_HALF_MENTION.test(key) ||
    (trailingHalf && TRAILING_HALF_AFTER_LINE.first.test(key))
  ) {
    return "HT";
  }
  if (TRAILING_HALF_AFTER_LINE.first.test(key) || TRAILING_HALF_AFTER_LINE.second.test(key)) return "OTHER";
  if (marketMapNumberOf(mercado, esporte) !== null) return "MAP";
  if (/\b(map|mapa|set)\s*\d/.test(key)) return "OTHER";
  return "FT";
}

const MATCH_SCOPE = MATCH_SCOPE_NOUNS.join("|");
/**
 * `full time result` e `resultado` nu: `classifyScoreMarket` liquida as duas
 * grafias como moneyline, e aqui precisam ser moneyline também para a aposta
 * não ficar sem CLV. O termo amplo é seguro porque `marketKindOf` o lê depois
 * de outright, placar exato, DNB, dupla chance, team total e handicap: todos
 * os "resultado de X" já saíram.
 */
const MONEYLINE_MARKET = new RegExp(
  String.raw`\b(moneyline|money line|match winner|winner|vencedor|1x2|ml)\b|^half time result$|\b(?:full time result|resultado)\b|\bganhador(?:a)? d[oa] (?:${MATCH_SCOPE})\b|\bpara (?:vencer|ganhar) (?:[oa] )?(?:${MATCH_SCOPE})\b|\bquem (?:vencera|vence|ganhara|ganha)\b`,
);

/**
 * `evento` é opcional e só amplia: sem ele o team total é reconhecido apenas
 * na forma com PREFIXO. Com ele, a forma com SUFIXO ("Total Goals" + "Over 1.5
 * Flamengo") é classificada aqui como em `classifyScoreMarket` — senão o preço
 * viria do total do JOGO, a liquidação usaria os gols do TIME e o CLV
 * compararia duas coisas diferentes.
 */
export function marketKindOf(
  mercado: string,
  selecao = "",
  evento?: string,
): MarketKind {
  const key = normalizeMercadoKey(mercado);
  if (!key) return "other";
  if (isOutrightMarket(mercado) || isMethodOfVictoryMarket(mercado)) return "other";
  // Combo (resultado ∧ ambas marcam, BTTS ∧ total) não é BTTS nem tem resolver:
  // precisa vir ANTES para não ser roteado como o mercado de uma perna só.
  if (isCombinedBttsMarket(mercado)) return "other";
  if (isBttsMarket(mercado)) return "btts";
  if (isRaceToMarket(mercado, selecao)) return "other";
  if (/\bcorrect score\b|\bplacar exato\b|\bresultado exato\b/.test(key)) return "correct_score";
  // "Marcar a Qualquer Momento" / Anytime / First / Last Goalscorer / To Score 2+ Goals
  if (
    /\b(?:goalscorer|anytime|marcador|artilheiro|marcar a qualquer momento|para marcar a qualquer momento|to score anytime|primeiro a marcar|primeiro marcador|primeiro gol|1o?\s*gol|1o?\s*marcador|any\s*1o?\s*gol|ultimo a marcar|ultimo marcador|ultimo gol|last goalscorer|first goalscorer|marcar 2 ou mais gols|to score 2 or more goals)\b/.test(
      key,
    )
  ) {
    return "scorer";
  }
  // N+ gols do jogador. Lido no texto com o "+", que a chave apaga: "Mais de
  // 2 gols" sem "+" é total de gols, não gol de jogador.
  const rawMarket = normalizeStr(mercado);
  if (
    /(?:^|[^\d.,])[2-9]\s*\+\s*(?:gols?|goals?)?(?:$|\s)/.test(rawMarket) ||
    /\b(?:to score|marcar)\s+(?:a\s+|um\s+)?(?:[2-9]\s+(?:or more|ou mais)\s+(?:gols?|goals?)|hat\s*-?\s*tricks?|brace)\b/.test(rawMarket) ||
    /^(?:hat\s*-?\s*tricks?|hattricks?|brace|bis)$/.test(rawMarket)
  ) {
    return "scorer";
  }
  // eSports Player Props & Basketball/Soccer Player Props
  if (/\bplayer\s+(?:tackles?|fouls?|passes?|cards?|yellow\s+cards?|red\s+cards?|interceptions?|key\s+passes?|offsides?|saves?)\b/.test(key)) {
    return "player_props";
  }
  if (
    !/\bteam\s+total/.test(key) && (
      /\b(?:player\s+(?:kills?|deaths?|abates?|mortes?)|(?:kills?|deaths?|abates?|mortes?)\s+(?:ht|1h|2h|do\s+jogador|da\s+jogadora|por\s+jogador|de\s+jogador)|deaths\s+ht|kills\s+ht|player\s*props?)\b|^(?:deaths|mortes|kills|abates|deaths\s+ht|kills\s+ht|player\s+props?)$/.test(
        key,
      ) ||
      /\b(?:player\s+assists|player\s+shots|player\s+shots\s+on\s+target|shots\s+on\s+target|chutes\s+ao\s+gol|chutes\s+no\s+gol)\b|^(?:shots|chutes|player\s*assists)$/.test(
        key,
      ) ||
      /\b(?:p\s*a\s*r|pra|player\s*pra|player\s+points\s+(?:and\s+)?rebounds\s+(?:and\s+)?assists|player\s+points\s*rebounds\s*assists|pontos\s+(?:e\s+)?rebotes\s+(?:e\s+)?assistencias|pontos\s+rebotes|pontos\s+assistencias|rebotes\s+assistencias|player\s+(?:points?|rebounds?|assists?|pts?|rebs?|ast))\b|^(?:p\s*a\s*r|pra|pontos|rebotes|assistencias)$/.test(
        key,
      )
    )
  ) {
    return "player_props";
  }
  if (isDrawNoBetMarket(mercado)) return "draw_no_bet";
  if (isDoubleChanceMarket(mercado)) return "double_chance";
  if (isTeamTotalMarket(mercado, selecao, evento)) return "team_total";
  // European Handicap é 3-way — não é spread asiático (settlement/odds recusam).
  if (isThreeWayHandicapMarket(mercado)) return "other";
  if (/\b(handicap|spread|ah)\b|\b(?:run|puck)\s*line\b/.test(key)) return "spread";
  // O escopo da vitória vem de `match-scope.ts`, o mesmo de
  // `classifyScoreMarket`: se os dois divergissem ("Para Ganhar a Partida"), a
  // aposta seria liquidável pelo placar mas ficaria sem CLV, e o filtro SQL
  // (mais largo) ainda a tiraria do IA-Judge.
  if (MONEYLINE_MARKET.test(key)) {
    // Alguns capturadores preservaram o mercado genérico "Moneyline" e
    // deixaram a semântica DNB apenas na seleção ("Time DNB"). O qualificador
    // da seleção prevalece somente aqui, depois de excluir mercados explícitos
    // (total, handicap, props etc.), para não converter uma contradição em DNB.
    return isDrawNoBetMarket(selecao) ? "draw_no_bet" : "moneyline";
  }
  // Alguns feeds nomeiam a estatística no mercado e deixam direção/linha só
  // na seleção ("Abates - Mapa 1" + "Over 25.5"). Restringir a kills evita
  // transformar qualquer prop desconhecida com a palavra Over em game total.
  if (/\b(?:kills?|abates?)\b/.test(key) && totalDirectionOf(selecao)) {
    return "total";
  }
  // "Goal Line"/"Linha de Gols" é a notação asiática do total. O settlement a
  // reconhece (`classifyScoreMarket`), e o roteamento de odds precisa fazer o
  // mesmo, senão a aposta fica em `other`, sem CLV.
  if (
    /\b(?:total|totais)\b|\bo u\b|\bover under\b|\b(?:over|under)\b|\b(?:mais menos|acima abaixo)\b|\b(?:mais|menos)\s+(?:de|que)\b/.test(key) ||
    /\bgoal\s*line\b|\blinha de (?:gols?|pontos?|runs?|corridas?|escanteios?|cantos?|cartoes?|carteos?|kills?|abates?)\b/.test(key)
  ) {
    return "total";
  }
  return "other";
}
