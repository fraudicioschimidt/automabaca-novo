import { accentVariants } from "@/src/domain/mercados/accents";
import {
  HALF_PERIOD_ABBREVIATIONS,
  HALF_PERIOD_PHRASES,
  OUTRIGHT_SCOPE_NOUNS,
  OUTRIGHT_WINNER_PHRASES,
} from "@/src/domain/mercados/classify";
import {
  doubleChanceSqlTerms,
  drawNoBetSqlTerms,
  type MarketVocabularyTerm,
} from "@/src/domain/mercados/draw-vocabulary";
import {
  knownScoreQualifierSqlTerms,
  nonScoreStatSqlTerms,
  SCORE_UNIT_RULES,
  scoreUnitTermsForSql,
} from "@/src/domain/mercados/stat-qualifier";
import type { Prisma } from "@/src/generated/prisma/client";

/**
 * Espelho no Postgres da classificação fina de `isScoreResolvableMarket`: uma
 * denylist (unidade, período, outright, placar exato, estatística) e uma
 * allowlist de mercados de placar. É deliberadamente aproximado — quem consulta
 * valida o domínio depois. O IA-Judge seleciona pelo `NOT` deste filtro, então
 * o que ele admite a mais some do lote.
 */
export function scoreResolvableMercadoWhere(): Prisma.BetWhereInput {
  return {
    AND: [
      ...scoreUnitExclusions(),
      ...unknownNamedQualifierExclusions(),
      ...partialPeriodExclusions(),
      ...outrightExclusions(),
      ...exactScoreExclusions(),
      ...statisticExclusions(),
      { OR: scoreMarketAllowlist() },
    ],
  };
}

const INSENSITIVE = "insensitive" as const;

function contains(term: string): Prisma.BetWhereInput {
  return { mercado: { contains: term, mode: INSENSITIVE } };
}

function notContaining(...terms: string[]): Prisma.BetWhereInput[] {
  return terms.map((term) => ({ NOT: contains(term) }));
}

function containsAny(values: readonly string[]): Prisma.BetWhereInput {
  return { OR: values.flatMap(accentVariants).map(contains) };
}

/** Sigla como TOKEN: sozinha, no começo, no meio ou no fim do rótulo. */
function abbreviationFilters(token: string, options: { alone: boolean }): Prisma.BetWhereInput[] {
  return [
    ...(options.alone ? [{ mercado: { equals: token, mode: INSENSITIVE } }] : []),
    { mercado: { startsWith: `${token} `, mode: INSENSITIVE } },
    { mercado: { contains: ` ${token} `, mode: INSENSITIVE } },
    { mercado: { endsWith: ` ${token}`, mode: INSENSITIVE } },
  ];
}

/** Termo do vocabulário de empate: todas as partes precisam aparecer. */
function vocabularyFilters(terms: MarketVocabularyTerm[]): Prisma.BetWhereInput[] {
  return terms.map(({ all }) => {
    const [first, ...rest] = all;
    if (first === undefined) return {};
    return rest.length === 0 ? contains(first) : { AND: [contains(first), ...rest.map(contains)] };
  });
}

/**
 * Linha em unidade que o placar agregado não responde (games/sets do tênis e
 * vôlei, legs de dardos, frames de snooker, mapas de eSports), derivada do
 * registro de esportes — o mesmo dado de `hasScoreUnitMismatch`.
 */
function scoreUnitExclusions(): Prisma.BetWhereInput[] {
  const sportRules = Object.values(SCORE_UNIT_RULES).map((rule): Prisma.BetWhereInput => {
    const sports: Prisma.BetWhereInput = {
      OR: rule.sports.map((sport) => ({
        esporte: { equals: sport, mode: INSENSITIVE },
      })),
    };
    return {
      NOT: {
        AND: [
          containsAny(rule.terms),
          rule.mode === "inside" ? { NOT: sports } : sports,
          ...(rule.mode === "inside"
            ? [{ NOT: { esporte: { equals: "" } } } as Prisma.BetWhereInput]
            : []),
        ],
      },
    };
  });
  return [...notContaining(...scoreUnitTermsForSql()), ...sportRules];
}

/**
 * Qualificador NOMEADO desconhecido falha fechado: sem isto, `Total de Xyzzy`
 * entraria pelo `startsWith` amplo de Total, embora o domínio o recuse.
 */
function unknownNamedQualifierExclusions(): Prisma.BetWhereInput[] {
  const knownQualifierTerms = knownScoreQualifierSqlTerms();
  return ["Total de ", "Total (", "Handicap de "].map((prefix) => ({
    NOT: {
      AND: [
        { mercado: { startsWith: prefix, mode: INSENSITIVE } },
        { NOT: { OR: knownQualifierTerms.map(contains) } },
      ],
    },
  }));
}

/**
 * Siglas de fase parcial (tempo, quarto, entrada, período, set, round). As de
 * meio-tempo são as do domínio; as numeradas cobrem 1 a 9.
 */
const PARTIAL_PHASE_ABBREVIATIONS = [
  ...HALF_PERIOD_ABBREVIATIONS.first,
  ...HALF_PERIOD_ABBREVIATIONS.second,
].map((token) => token.toUpperCase()).concat(
  ["F5", "ET", "OT", "PEN", "SO"],
  ...["Q", "P", "S"].map((suffix) => Array.from({ length: 9 }, (_, index) => `${index + 1}${suffix}`)),
  ...["I", "S", "R"].map((prefix) => Array.from({ length: 9 }, (_, index) => `${prefix}${index + 1}`)),
);

/** Unidades e fases parciais não podem consumir o placar agregado final. */
function partialPeriodExclusions(): Prisma.BetWhereInput[] {
  return [
    ...notContaining("european", "europeu", "3-way", "3 way", "three way", "3 vias"),
    // Frases de meio-tempo do domínio, as mesmas que a regex de período usa.
    ...notContaining(...HALF_PERIOD_PHRASES.first, ...HALF_PERIOD_PHRASES.second),
    // "1°T" com o sinal de grau é a mesma grafia do "1ºT" ordinal, e o
    // feminino ("1ª Parte", "1ª metade") perde o ordinal na chave do domínio.
    ...notContaining("1º", "2º", "1°", "2°", "1ª", "2ª", "first half"),
    {
      NOT: {
        OR: PARTIAL_PHASE_ABBREVIATIONS.flatMap((token) => abbreviationFilters(token, { alone: false })),
      },
    },
    ...notContaining("quarter", "quarto", "period", "período", "periodo", "inning"),
    ...[" round", " frame", " leg", " set"].flatMap((word) => [
      { NOT: contains(word) },
      { NOT: { mercado: { startsWith: word.trim().replace(/^./, (c) => c.toUpperCase()), mode: INSENSITIVE } } },
    ]),
    ...notContaining("game handicap", "game total", "total game"),
    ...Array.from({ length: 9 }, (_, index) => ({
      NOT: { OR: [contains(`game ${index + 1}`), contains(`game${index + 1}`)] },
    })),
    // "90 min" e as janelas de minutos ("0-10 min", "0-10min", "primeiros 10 minutos").
    ...notContaining("regulation", "tempo regulamentar", "90 min", "minuto", "minute"),
    { NOT: { OR: abbreviationFilters("min", { alone: false }) } },
    ...notContaining(...Array.from({ length: 10 }, (_, digit) => `${digit}min`)),
    // A fase isolada é bloqueada; variantes que declaram Including/Incl OT
    // continuam FT e passam para o gate fino do domínio.
    ...["extra time", "overtime"].map((phase) => ({
      NOT: { AND: [contains(phase), ...notContaining("including", "incl")] },
    })),
    {
      NOT: {
        AND: [
          { OR: [contains("prorroga"), contains("prolongamento")] },
          ...notContaining("including", "incl", "incluindo", "inclui"),
        ],
      },
    },
    ...notContaining("shootout", "shoot out"),
  ];
}

/**
 * Outright: o par (verbo, escopo) vem do mesmo dado do domínio ("vencedor do
 * torneio/campeonato/competição"), mais os rótulos de futuro/campeão.
 */
function outrightExclusions(): Prisma.BetWhereInput[] {
  return [
    { NOT: { AND: [containsAny(OUTRIGHT_WINNER_PHRASES), containsAny(OUTRIGHT_SCOPE_NOUNS)] } },
    ...notContaining(
      "outright", "future", "to lift", "to win the",
      "campeão", "campeao", "campeã", "campea",
      "vencedor final", "vencedora final",
    ),
  ];
}

function exactScoreExclusions(): Prisma.BetWhereInput[] {
  return [
    ...notContaining(
      "resultado exato", "placar exato", "correct score",
      "handicap result", "resultado handicap",
    ),
    {
      NOT: {
        AND: [
          contains("handicap"),
          { OR: ["0:1", "1:0", "0:2", "2:0", "1:2", "2:1"].map(contains) },
        ],
      },
    },
  ];
}

/**
 * Estatística e prop de jogador. A lista do domínio vem primeiro (o
 * `startsWith: "Total"` da allowlist admitiria "Total de Assistências"); os
 * termos escritos aqui cobrem alternativas que lá são regex.
 */
function statisticExclusions(): Prisma.BetWhereInput[] {
  return [
    ...notContaining(...nonScoreStatSqlTerms()),
    ...notContaining(
      "corner", "escanteio", "card", "cart",
      // "Total (Bookings)" começa com Total, mas é estatística.
      "booking", "player", "prop", "map",
      // Props de jogador em PT: o positivo "gol" não pode puxá-las.
      "jogador", "marcador", "artilheiro", "marcar",
      "rebound", "rebote", "aces", "bases", "steal", "turnover", "block", "hit",
      "strikeout", "fault", "pointer",
      // Cesta de três sem o `-er`. `contains: "point"` sozinho não serve:
      // "Total Points" do basquete é mercado de PLACAR legítimo.
      "3-point", "3 point", "three point", "triple",
      "offside", "passe", "pass", "touch", "interception", "cross",
      "dragon", "baron", "inhibitor", "strike", "takedown", "submission",
    ),
  ];
}

/**
 * Mercados de placar. Aproximação ampla: `classifyScoreMarket` continua sendo
 * o gate fino e recusa outrights e estatísticas que passem daqui.
 */
function scoreMarketAllowlist(): Prisma.BetWhereInput[] {
  return [
    contains("moneyline"),
    contains("match winner"),
    contains("winner"),
    ...abbreviationFilters("ML", { alone: true }),
    // "Para Ganhar o Jogo", "Quem vencerá/vence/ganha…": o prefixo cobre as
    // flexões; o gate fino recusa a variante de outright.
    contains("para vencer"),
    contains("para ganhar"),
    contains("quem vence"),
    contains("quem ganha"),
    contains("1x2"),
    contains("asian handicap"),
    contains("asian total"),
    contains("handicap"),
    contains("spread"),
    ...abbreviationFilters("AH", { alone: true }),
    contains("puck line"),
    contains("puckline"),
    contains("run line"),
    contains("runline"),
    ...vocabularyFilters(drawNoBetSqlTerms()),
    ...abbreviationFilters("DNB", { alone: true }),
    ...vocabularyFilters(doubleChanceSqlTerms()),
    ...abbreviationFilters("DC", { alone: true }),
    // Prefixos sem espaço cobrem Total/Total-Match/Total – Match e Totais.
    { mercado: { startsWith: "Total", mode: INSENSITIVE } },
    { mercado: { startsWith: "Totais", mode: INSENSITIVE } },
    contains("total points"),
    contains("total goals"),
    contains("over/under"),
    ...abbreviationFilters("Over", { alone: true }),
    ...abbreviationFilters("Under", { alone: true }),
    contains("goal line"),
    // "Linha de …" só NOMEADA: um `contains: "linha de"` amplo admitiria
    // "Linha de Assistências/Faltas", que perderiam o IA-Judge.
    contains("linha de gols"),
    contains("linha de pontos"),
    contains("linha de runs"),
    contains("linha de corridas"),
    contains("team total"),
    contains("total do time"),
    contains("total da equipe"),
    contains("do time"),
    contains("da equipe"),
    contains("btts"),
    contains("both teams"),
    contains("ambas marcam"),
    contains("ambos marcam"),
    contains("ambas equipes marcam"),
    contains("both score"),
    // Vocabulário PT de totais que `classifyScoreMarket` aceita.
    contains("mais de"),
    contains("menos de"),
    contains("mais que"),
    contains("menos que"),
    contains("acima"),
    contains("abaixo"),
    contains("gol"),
    contains("resultado final"),
    contains("resultado do jogo"),
    contains("resultado da partida"),
    contains("vencedor"),
    contains("ganhador"),
  ];
}
