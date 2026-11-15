import { esportesComUnidade, termosDeUnidadeSemPlacar } from "@/src/domain/sports/registry";
import { normalizeStr } from "@/src/domain/text";
import { accentuate } from "./accents";

/**
 * Vocabulário único de mercados cuja UNIDADE é uma estatística (cartões,
 * escanteios, props de jogador…), e não o placar da partida.
 *
 * Vive em `mercados/` porque dois consumidores precisam dele antes do
 * settlement: a coerção de mercado no registro (`coerce.ts`, que não pode
 * apagar a estatística ao reescrever o rótulo) e o roteamento de providers
 * (`providers/coverage.ts`). `settlement/markets.ts` reexporta para os callers
 * históricos — uma implementação, três bordas.
 */
/** Fonte única das alternativas; o espelho SQL é gerado daqui (ver `nonScoreStatSqlTerms`). */
export const NON_SCORE_STAT_TERMS =
  // Subfamílias compostas vêm antes do termo genérico. Além de proteger o
  // placar, elas permitem que a seleção refine o mercado sem depender de o
  // qualificador ficar colado à palavra genérica ("Cartões Amarelos Over",
  // "Chutes no Gol Over").
  "(?:yellow|red)\\s+cards?|cartoes?\\s+(?:amarelos?|vermelhos?)|amarelos?|vermelhos?|" +
  "chutes?\\s+(?:ao?|no)\\s+(?:gol|alvo)|finalizacoes?\\s+(?:ao?|no)\\s+(?:gol|alvo)|" +
  "remates?\\s+(?:a(?:o)?|no)\\s+baliza|remates?\\s+(?:a(?:o)?|no)\\s+alvo|" +
  "remates?\\s+(?:a(?:o)?|no)\\s+gol|remates?\\s+enquadrados?|" +
  "shots?\\s+on\\s+(?:target|goal)|duplas?\\s+faltas?|" +
  "sofre\\s+faltas?|comete\\s+faltas?|fouls?\\s+suffered|fouls?\\s+committed|" +
  "posse\\s+de\\s+bola|ball\\s+possession|foras?\\s+de\\s+jogo|" +
  "pontapes?\\s+de\\s+baliza|tiros?\\s+de\\s+meta|goal\\s+kicks?|" +
  "free\\s+kicks?|grandes?\\s+penalidades?|lancamentos?\\s+laterais?|throw[\\s-]*ins?|" +
  "ataques?\\s+perigosos?|dangerous\\s+attacks?|bolas?\\s+na\\s+trave|woodwork|" +
  "cartao|cartoes|carteos|cards?|bookings?|escanteios?|cantos?|corners?|chutes?|shots?|remates?|" +
  "finalizacoes?|faltas?|fouls?|torres?|towers?|mapa|mapas|maps?|kills?|abates?|deaths?|mortes?|" +
  "dragons?|dragoes?|barons?|baroes?|inhibitors?|inibidores?|" +
  "strikes?|golpes?|takedowns?|quedas?|submissions?|finalizacoes? de luta|" +
  "defesas?|saves?|jogador|player|scorer|marcador|artilheiro|assistencias?|assists?|" +
  "rebounds?|rebotes?|aces|bases|steals?|roubos?|roubadas?|turnovers?|perdas?|" +
  "blocks?|bloqueios?|tocos?|hits?|" +
  // "3 point"/"three point" SEM o `-er` existe e é como a casa costuma
  // escrever a linha; só `pointers?` deixaria a cesta de três ser julgada pelo
  // PLACAR de pontos (contrato em `tests/liquidacao/settlement-statistics-vocabulary.test.ts`).
  "strikeouts?|double faults?|faltas duplas?|3[\\s-]*pointers?|3[\\s-]*points?|" +
  "three pointers?|three points?|triples?|triplas?|pra|" +
  "offsides?|impedimentos?|passes?|touches?|toques?|interceptions?|interceptacao|" +
  "interceptacoes?|" +
  "crosses?|cruzamentos?|tackles?|desarmes?|clearances?|cortes?|afastamentos?|" +
  "sacks?|first downs?|home runs?|" +
  "rbis?|field goals?|posse|livres?|penaltis?|substituicoes?|substitutions?|laterais?|" +
  "ataques?|attacks?";

const NON_SCORE_STAT_RE = new RegExp(`\\b(?:${NON_SCORE_STAT_TERMS})\\b`);
/**
 * Como a casa liga o NÚMERO à estatística: direto ("2 cartões"), com o `+` de
 * "no mínimo" ("2+ cards") ou por extenso ("2 or more cards", "2 ou mais
 * cartões").
 *
 * Sem o `+` e o "or more" a seleção não declara estatística, o mercado segue
 * liquidável por PLACAR e, como a seleção carrega o nome do time, o resolver de
 * lado casa e liquida: "Time 2+ cards" num jogo 2×1 viraria `WON` sem olhar um
 * cartão. E como o espelho SQL segue o domínio, a aposta também sairia do
 * IA-Judge, que é quem revisaria.
 */
const CONECTOR_DE_LINHA = "(?:\\s*\\+|\\s+(?:or more|ou mais|no minimo|at least))?\\s*";
const LINE_THEN_STAT_RE = new RegExp(
  `\\d+(?:[.,]\\d+)?${CONECTOR_DE_LINHA}(?:${NON_SCORE_STAT_TERMS})\\b`,
);
/**
 * `9.5` sem sinal, ou palavra de direção. O sinal ficou de FORA de propósito:
 * `[+\-]?\d` fazia "Las Vegas Aces -3.5" — handicap num time de verdade da WNBA
 * — parecer declaração de linha de aces. Handicap ESTATÍSTICO de verdade
 * ("Escanteios Handicap +2.5") nomeia a estatística no MERCADO e é reconhecido
 * antes de chegar aqui.
 */
const STAT_THEN_LINE_RE = new RegExp(
  `\\b(?:${NON_SCORE_STAT_TERMS})\\s*(?:over|under|mais|menos|acima|abaixo|\\d)`,
);

const BOTH_TEAMS_CARDS_RE = new RegExp(
  [
    // Rótulo explícito da casa/captura: "Both Teams Cards" ou "Ambas as
    // equipes recebem 2+ cartões". O limite impede atravessar outra aposta em
    // legendas com vários blocos.
    "\\b(?:both teams(?: to)? receive|ambas(?: as equipes)? recebem|ambos(?: os times)? recebem)\\b[^\\n]{0,80}\\b(?:cards?|bookings?|cartao|cartoes|carteos)\\b",
    "\\bboth teams\\s+(?:cards?|bookings?)\\b",
    // "Both Teams Over 0.5 cards": a direção fica entre o sujeito e a unidade.
    // Sem isto o classificador de jogador lia "Both Teams" como atleta.
    "\\b(?:both teams|ambas(?: as equipes)?|ambos(?: os times)?)\\s+(?:over|under|mais|menos|acima|abaixo)\\s+\\d+(?:[.,]\\d+)?\\s+(?:cards?|bookings?|cartao|cartoes|carteos)\\b",
    // Forma compacta observada em produção: "Ambas 2+ cartões". O número deve
    // vir logo depois do sujeito; assim "ambas marcam e over 2 cards" (combo
    // diferente) não é promovido silenciosamente para este mercado.
    "\\b(?:both teams|ambas(?: as equipes)?|ambos(?: os times)?)\\s+(?:\\+\\s*)?\\d+(?:[.,]\\d+)?(?:\\s*\\+|\\s+(?:or more|ou mais|no minimo|at least))?\\s+(?:cards?|bookings?|cartao|cartoes|carteos)\\b",
  ].join("|"),
);

/** A linha exige que CADA time alcance o mínimo de cartões, não o total do jogo. */
export function isBothTeamsCardsText(text: string): boolean {
  return BOTH_TEAMS_CARDS_RE.test(normalizeStr(text));
}

/**
 * A seleção DECLARA uma linha de estatística — não apenas contém uma palavra que
 * por acaso é nome de estatística.
 *
 * É a distinção que separa "Total / Over 9.5 Aces" de "Las Vegas Aces" no
 * moneyline, e ela vale para todo mundo que pergunta "isto é mercado de
 * estatística?": tanto a coerção de mercado quanto o roteamento do settlement.
 */
export function selecaoDeclaraLinhaDeEstatistica(selecao: string): boolean {
  const selectionN = normalizeStr(selecao);
  return LINE_THEN_STAT_RE.test(selectionN) || STAT_THEN_LINE_RE.test(selectionN);
}

/** Mercados de estatística (cartões, escanteios, props…) nunca resolvem por placar. */
export function hasNonScoreStatQualifier(mercado: string, selecao: string): boolean {
  const marketN = normalizeStr(mercado);
  if (NON_SCORE_STAT_RE.test(marketN)) return true;
  return selecaoDeclaraLinhaDeEstatistica(selecao);
}

/** Unidades que nomeiam o placar ou uma parcial dele (gols, pontos, corridas, sets, games, mapas…). */
export function scoreQualifierTerms(): string[] {
  return [
    ...Object.values(SCORE_UNIT_RULES).flatMap((rule) => [...rule.terms]),
    ...termosDeUnidadeSemPlacar().flatMap((term) => {
      const singular = term.replace(/s\?$/, "");
      return term.endsWith("s?") ? [singular, `${singular}s`] : [singular];
    }),
  ];
}
const STRUCTURAL_QUALIFIER_RE =
  /^(?:asian|match|game|jogo|partida|team|time|equipe|home|away|casa|visitante|mandante)(?:\s+(?:match|game|jogo|partida|team|time|equipe))?$/;

/**
 * Um rótulo que nomeia a UNIDADE de Total/Handicap não pode cair aberto no
 * placar só porque essa unidade ainda não entrou no vocabulário. A lista de
 * estatísticas continua útil para roteamento e diagnóstico; esta gramática é
 * o último portão financeiro para o universo aberto de nomes de mercado.
 */
export function hasUnknownScoreQualifier(mercado: string): boolean {
  const marketN = normalizeStr(mercado).replace(/\s+/g, " ").trim();
  const patterns = [
    /\btotal\s+(?:de|do|da)\s+(.+)$/,
    /\btotal\s*\(([^)]+)\)/,
    /^(.+?)\s+total(?:\s*[-–—]?\s*(?:match|game|jogo|partida))?$/,
    /\bhandicap\s+(?:de|do|da)\s+(.+)$/,
    /^(?:time|team|equipe)\s*(?:1|2|da casa|visitante|home|away)\s*[-–—:]\s*(.+)$/,
  ] as const;

  for (const pattern of patterns) {
    const qualifier = marketN.match(pattern)?.[1]
      ?.replace(/\b(?:ft|full time|match|game|jogo|partida)\b/g, " ")
      .replace(/\b\d+(?:[.,]\d+)?\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!qualifier) continue;
    if (STRUCTURAL_QUALIFIER_RE.test(qualifier)) continue;
    if (NON_SCORE_STAT_RE.test(qualifier)) continue;
    const scoreQualifierRe = new RegExp(
      `\\b(?:${[...new Set(scoreQualifierTerms())].join("|")})\\b`,
    );
    if (scoreQualifierRe.test(qualifier)) continue;
    return true;
  }
  return false;
}

/** Termos aceitos pelo espelho SQL ao filtrar qualificadores nomeados. */
export function knownScoreQualifierSqlTerms(): string[] {
  return [...new Set([
    ...scoreQualifierTerms().map((term) => term.replace(/s\?$/, "")),
  ])];
}

/**
 * Termos `contains` da denylist SQL, DERIVADOS das mesmas alternativas da
 * regex. O `startsWith: "Total"` da allowlist admitia "Total de Assistências"
 * — que o domínio recusa — e a aposta saía do IA-Judge para um lote que nunca
 * a liquidaria. Alternativa com sintaxe de regex além do plural opcional fica
 * de fora: essas já têm filtro escrito à mão e um teste cobra a cobertura.
 */
export function nonScoreStatSqlTerms(): string[] {
  const termos = new Set<string>();
  for (const alternativa of NON_SCORE_STAT_TERMS.split("|")) {
    const semPlural = alternativa.replace(/s\?$/, "");
    if (/[[\]()?*+{}\\]/.test(semPlural)) continue;
    termos.add(semPlural);
    const acentuado = accentuate(semPlural);
    if (acentuado !== semPlural) termos.add(acentuado);
  }
  return [...termos];
}

/**
 * Unidade da linha e esportes em que ela É o placar. Exportado como DADO
 * porque o filtro SQL precisa do mesmo par (termo, esporte) para não admitir
 * o que o domínio recusa — divergir ali tira a aposta do IA-Judge.
 */
export const SCORE_UNIT_RULES = {
  goals: {
    terms: ["gol", "gols", "goal", "goals"],
    sports: esportesComUnidade("gols"),
    mode: "inside",
  },
  /** Corrida só é o placar em beisebol, softbol e críquete. */
  runs: {
    terms: ["runs", "run", "corridas", "corrida"],
    sports: [
      ...esportesComUnidade("corridas"),
      // Softbol não é modalidade canônica (não dá para registrar aposta nela),
      // mas o campo `esporte` é texto livre em dado legado — manter o termo
      // custa nada e evita reabrir a fresta que a lista fechou.
      "softball",
      "softbol",
    ],
    /** `inside` = a unidade vale NOS esportes listados; fora deles é fail-closed. */
    mode: "inside",
  },
  /**
   * Ponto só É o placar onde o painel conta pontos. É lista de permissão, não
   * de recusa: em hockey, futebol ou eSports "pontos" não é o número que o feed
   * entrega (`Total de Pontos Over 5.5` num hockey 4x2 seria liquidado pelos
   * GOLS), e esporte fora da lista falha fechado (portão:
   * `tests/liquidacao/score-resolvable-mercado-where.test.ts`).
   */
  points: {
    terms: ["points", "point", "pontos", "ponto"],
    sports: esportesComUnidade("pontos"),
    mode: "inside",
  },
} as const;

/**
 * Unidades que o placar agregado NUNCA responde, DERIVADAS do registro de
 * esportes (`unidadeDoPlacar`), e não de uma lista fixa: esporte novo (dardos
 * com `legs`, snooker com `frames`) traz a recusa junto, em vez de ter a linha
 * julgada contra um placar de unidade não medida.
 */
const UNIDADE_SEM_PLACAR_RE = new RegExp(
  `\\b(?:${termosDeUnidadeSemPlacar().join("|")})\\b`,
);

/** Espelho SQL da recusa acima — ver `scoreUnitTermsForSql`. */
export function scoreUnitTermsForSql(): string[] {
  // `contains` no Postgres é SUBSTRING, não palavra: o termo vai no PLURAL,
  // como "games" já ia, para não casar pedaço de outra palavra. Mais estreito
  // que o domínio no singular, e é o lado seguro — o caller revalida no domínio.
  return termosDeUnidadeSemPlacar().map((termo) => termo.replace(/s\?$/, "s"));
}

/**
 * Unidade da linha que NÃO é o placar agregado do esporte. Vive aqui junto do
 * vocabulário de estatística porque a coerção de mercado precisa da mesma
 * resposta ANTES do settlement: reescrever o rótulo apagaria a evidência.
 *
 * Games e sets ficam recusados até comprovar a unidade do feed.
 * Gols, pontos e corridas são listas de permissão por esporte: corridas/runs só são
 * o placar em beisebol/softbol/críquete (em futebol e basquete "corridas" é
 * estatística) e pontos só em basquete/futebol americano/rugby (em
 * hockey, futebol e vôlei o feed entrega gols ou sets). Fora da lista, e
 * com esporte conhecido, falha fechado.
 */
export function hasScoreUnitMismatch(
  mercado: string,
  selecao: string,
  esporte?: string,
): boolean {
  const combined = normalizeStr(`${mercado} ${selecao}`);
  return UNIDADE_SEM_PLACAR_RE.test(combined) ||
    // Round é a unidade de dentro do mapa/luta, não o placar em mapas.
    /\b(?:game\s+(?:handicap|total)|total\s+game|rounds|rounds?\s+(?:total|handicap)|(?:total|handicap)\s+(?:de\s+)?rounds?)\b/.test(combined) ||
    hasSportScoreUnitMismatch(mercado, selecao, esporte);
}

/** Unidade explícita do placar que pertence a outra modalidade. */
export function hasSportScoreUnitMismatch(mercado: string, selecao: string, esporte?: string): boolean {
  const sport = normalizeStr(esporte ?? "").trim();
  if (!sport) return false;
  const combined = normalizeStr(`${mercado} ${selecao}`);
  return Object.values(SCORE_UNIT_RULES).some((rule) =>
    new RegExp(`\\b(?:${rule.terms.join("|")})\\b`).test(combined) &&
    !(rule.sports as readonly string[]).includes(sport),
  );
}
