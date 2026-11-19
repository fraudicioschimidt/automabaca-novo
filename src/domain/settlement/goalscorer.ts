import { normalizeStr } from "@/src/domain/text";
import { marketNamesBothHalves, marketPeriodOf } from "@/src/domain/mercados/classify";
import {
  encontrarJogadorNaPartida,
  listedButDidNotPlay,
  participationUnproven,
  temPolaridadeNegativa,
  type GoalscorerResolution,
  type JogadorDaPartida,
  type JogadorNomeado,
  type PlayerNameMatch,
} from "@/src/domain/settlement/goalscorer-matching";

const ARTILHEIRO_COM_ORDEM =
  /\b(?:first|last|1st|primeiro|ultimo|2nd|second|segundo)\b/;

/**
 * Gol de TIME ("Both Teams to Score", o nome gravado para Ambas Marcam; "Home
 * to Score"; "Primeiro Time a Marcar"): não é pergunta sobre jogador, e quem
 * responde é o placar. "Any Time to Score" continua artilheiro. O nome do time
 * no mercado ("Flamengo to Score") pede os times do evento e fica de fora.
 */
const TEAM_GOAL =
  /(?<!\bany\s)\b(?:teams?|time|equipe|home|away)\s+(?:(?:da casa|visitante|mandante)\s+)?(?:(?:not|nao)\s+)?(?:to\s+score|a\s+marcar|marcar)\b/;
/**
 * O time citado é o do jogador ("Jogador da Equipe Visitante a Marcar",
 * "Anytime Goalscorer - Away Team to Score"): a pergunta é o gol dele.
 */
const PLAYER_OF_TEAM = /\bjogador\s+d[oa]\s+(?:time|equipe)\b|\b(?:goalscorer|artilheiro)\b/;

function namesTeamGoal(texto: string): boolean {
  return TEAM_GOAL.test(texto) && !PLAYER_OF_TEAM.test(texto);
}

/**
 * Artilheiro que o FlashScore sabe resolver: só ANYTIME. First/Last exigem a
 * ordem do gol, que a lista de jogadores não traz.
 */
export function ehMercadoArtilheiro(mercado: string, selecao?: string): boolean {
  // "Marcar nos dois tempos" tem período OTHER, mas continua gol de jogador:
  // fora daqui o classificador de prop o leria como gol a qualquer momento. Quem
  // o recusa é o qualificador, em `resolveGoalscorer`.
  const bothHalves = marketNamesBothHalves(mercado) || (selecao ? marketNamesBothHalves(selecao) : false);
  if (!bothHalves && marketPeriodOf(mercado) !== "FT") {
    return false;
  }
  if (!bothHalves && selecao && marketPeriodOf(selecao) !== "FT") {
    return false;
  }
  const texto = normalizeStr(mercado);
  if (namesTeamGoal(texto)) return false;
  const ehArtilheiro =
    /\bgoalscorer\b/.test(texto) ||
    /\bmarcar a qualquer momento\b/.test(texto) ||
    /\banytime\b/.test(texto) ||
    /\bto score\b/.test(texto) ||
    /(?:^|[^\d.,])\d\s*\+\s*(?:gols?|goals?)\b/.test(texto) ||
    /\bhat\s*-?\s*tricks?\b|\bhattricks?\b|\bbrace\b|\bbis\b/.test(texto) ||
    /\banytime scorer\b/.test(texto);
  return ehArtilheiro && !ARTILHEIRO_COM_ORDEM.test(texto);
}

/**
 * Mercado de gol de jogador em 1º ou 2º TEMPO.
 *
 * Separado de `ehMercadoArtilheiro` porque aquele recusa período fora do tempo
 * integral de propósito — é o contrato do resolvedor que usa a estatística
 * agregada. Aqui a prova é outra: o minuto do gol, no resumo da partida.
 *
 * O vocabulário é estreito de propósito: `marcar` sozinho pegaria mercado de
 * TIME ("time da casa marcar"), que hoje resolve pelo placar e passaria a cair
 * em manual.
 */
const ARTILHEIRO_POR_TEMPO = [
  // `normalizeStr` tira acento mas PRESERVA o ordinal masculino: "1º Tempo" vira
  // "1º tempo", não "1o tempo". Sem aceitar o símbolo, a grafia que a casa
  // brasileira usa de verdade não casaria.
  /\bmarcar\b[^|]{0,40}[\s(]?(?:1|2|primeiro|segundo)\s*[º°o]?\s*tempo\b/,
  /\b(?:first|second|1st|2nd)\s+half\b[^|]{0,40}(?:goalscorer|to score|scorer)\b/,
  /\b(?:anytime\s+)?(?:goalscorer|to score)\b[^|]{0,40}\b(?:first|second|1st|2nd)\s+half\b/,
];

export function ehMercadoArtilheiroPorTempo(mercado: string, selecao?: string): boolean {
  if (namesTeamGoal(normalizeStr(mercado))) return false;
  const texto = `${normalizeStr(mercado)} ${selecao ? normalizeStr(selecao) : ""}`;
  if (!ARTILHEIRO_POR_TEMPO.some((padrao) => padrao.test(texto))) return false;
  // O ordinal precisa falar do GOL, não do TEMPO. `ARTILHEIRO_COM_ORDEM` casa
  // qualquer "1st"/"primeiro", então "1st Half Goalscorer" — que é anytime
  // dentro do 1º tempo — seria descartado como se fosse "primeiro a marcar".
  // Some-se a frase do período antes de procurar ordem.
  const semPeriodo = normalizeStr(mercado)
    .replace(/\b(?:first|second|1st|2nd)\s+half\b/g, " ")
    .replace(/\b(?:1|2|primeiro|segundo)\s*[º°o]?\s*tempo\b/g, " ");
  return !ARTILHEIRO_COM_ORDEM.test(semPeriodo);
}

/**
 * Qualificador que troca "marcou?" por uma pergunta que a lista de jogadores
 * não responde: gol de cabeça, de fora da área, de pênalti ou de falta, nos
 * dois tempos, ou o gol combinado com outra coisa ("ou dar assistência",
 * "& Win", dois jogadores). A aposta continua sendo de gol de jogador (o
 * classificador de prop não a pega), mas os resolvedores a mandam ao operador.
 */
const GOAL_QUALIFIER =
  /\b(?:assist\w*|header|cabeca|fora da area|outside the box|de longe|long range|penalt\w*|free kick|de falta)\b/;
/**
 * O conectivo só combina com termo dos dois lados, e mercado e seleção são
 * lidos em separado: "Or Dasa" abre com o nome, não liga o gol a nada.
 */
const GOAL_COMBINATION = /\S\s*[&+]\s*\S|\S\s+(?:e|and|ou|or)\s+\S/;
/** Inicial de nome ("Haaland E.", a grafia do FlashScore): o "E." não é o conectivo "e". */
const NAME_INITIAL = /\b[a-z]\.(?!\w)/g;

function qualifierText(texto: string): string {
  return normalizeStr(texto)
    // "N ou mais" e "N+" são quantidade de gols, que `requiredPlayerGoals` lê.
    .replace(/(?<![\d.,])\d{1,2}\s*(?:ou|or)\s*(?:mais|more)\b/g, " ")
    .replace(/(?<![\d.,])\d{1,2}\s*\+/g, " ")
    .replace(NAME_INITIAL, " ");
}

export function hasUnsupportedGoalQualifier(mercado: string, selecao = ""): boolean {
  const market = qualifierText(mercado);
  const selection = qualifierText(selecao);
  // Os dois tempos pelo vocabulário do período ("1H/2H", "em cada tempo"):
  // grafia que o período lê como OTHER tem de ser qualificador aqui também.
  return GOAL_QUALIFIER.test(`${market} ${selection}`) ||
    marketNamesBothHalves(mercado) || marketNamesBothHalves(selecao) ||
    GOAL_COMBINATION.test(market) || GOAL_COMBINATION.test(selection);
}

export type OrderedGoalscorerOrder = "first" | "last";

/**
 * Qualificadores de período (half, tempo, 1t, 2t, quarter) que indicam mercado de período específico.
 * "1st Half Goalscorer" ou "1º Tempo Marcador" qualificam o período do jogo (HT),
 * não a ordem (first/last) do gol no confronto inteiro (FT).
 */
const PERIOD_QUALIFIERS = /\b(?:half|tempo|quarter|quarto|1t|2t|1h|2h|1q|2q)\b/i;

/**
 * First/Last são outra família de settlement: `GOALS` prova quantidade, mas
 * não ordem. O rótulo precisa declarar inequivocamente primeiro ou último do jogo inteiro.
 */
export function orderedGoalscorerMarketOrder(
  mercado: string,
  selecao?: string,
): OrderedGoalscorerOrder | null {
  const texto = normalizeStr(mercado);
  const contexto =
    /\b(?:goalscorer|scorer|marcador|artilheiro|marcar)\b/.test(texto);
  // Aqui qualquer time citado recusa, também o do jogador: o primeiro gol do
  // time pode ser o segundo da partida, e a ordem lida é a do jogo inteiro.
  if (!contexto || TEAM_GOAL.test(texto)) return null;

  // Recusa qualquer mercado que nao seja de tempo integral (FT).
  if (marketPeriodOf(mercado) !== "FT") {
    return null;
  }
  if (selecao && marketPeriodOf(selecao) !== "FT") {
    return null;
  }

  // Desconsidera qualificadores de período (1st Half, 1º Tempo, 1T, etc.).
  if (PERIOD_QUALIFIERS.test(texto)) {
    return null;
  }

  const hasFirst = /\b(?:first|1st|primeiro|primeira)\b/.test(texto);
  const hasLast = /\b(?:last|ultimo|ultima)\b/.test(texto);

  // Mercados compostos com ambos os termos (ex: "First or Last Goalscorer") não têm ordem unívoca.
  if (hasFirst && hasLast) return null;
  if (hasFirst) return "first";
  if (hasLast) return "last";
  return null;
}

export type OrderedGoal = JogadorNomeado & {
  minuto: string;
  ordinal: number;
};

type OrderedGoalscorerMatchRefusal = Extract<
  PlayerNameMatch<JogadorDaPartida>,
  { ok: false }
>["reason"];

export type OrderedGoalscorerRefusal =
  | OrderedGoalscorerMatchRefusal
  | "mercado_sem_ordem"
  | "sem_gols"
  | "jogador_do_gol_ausente"
  | "polaridade_negativa"
  | "participacao_nao_comprovada"
  | "quantidade_de_gols_desconhecida"
  | "periodo_nao_suportado"
  | "qualificador_sem_contrato"
  /** Reserva que pode ter entrado depois do primeiro gol: a casa anularia. */
  | "entrada_apos_primeiro_gol_nao_descartada";

export type OrderedGoalscorerResolution =
  | {
      ok: true;
      ordem: OrderedGoalscorerOrder;
      /** VOID: o jogador escolhido estava no elenco e não entrou. */
      status: "WON" | "LOST" | "VOID";
      jogadorSelecionado: JogadorDaPartida;
      jogadorDoGol: OrderedGoal;
      similaridade: number;
      vantagem: number;
    }
  | { ok: false; reason: OrderedGoalscorerRefusal; candidatos?: string[] };

/**
 * Fim mais tardio do tempo normal com acréscimo, na escala dos minutos jogados:
 * com ele, os minutos do reserva dão a entrada mais tardia possível.
 */
const LATEST_REGULATION_END = 105;

/**
 * No primeiro a marcar, a casa anula a aposta no reserva que entrou depois do
 * primeiro gol. O titular estava em campo; o reserva só perde quando os minutos
 * jogados provam que ele entrou antes do minuto do gol. O minuto de entrada não
 * vem no feed, e sem essa prova a aposta vai ao operador.
 */
function onPitchBeforeGoal(jogador: JogadorDaPartida, minutoDoGol: string): boolean {
  if (jogador.titular === true) return true;
  const golBase = minutoBase(minutoDoGol);
  if (jogador.minutosJogados === undefined || golBase === null) return false;
  return LATEST_REGULATION_END - jogador.minutosJogados < golBase;
}

/** Minuto base de "45+2" é 45: o acréscimo pertence ao tempo que termina. */
export function minutoBase(raw: string): number | null {
  const limpo = raw.trim().replace(/[’']$/, "");
  const parsed = /^(\d{1,3})(?:\s*\+\s*\d{1,2})?$/.exec(limpo);
  const base = parsed?.[1] === undefined ? Number.NaN : Number(parsed[1]);
  return Number.isInteger(base) && base >= 1 && base <= 130 ? base : null;
}

/**
 * A seleção é casada contra o roster completo, nunca só contra o autor do gol.
 * Isso permite afirmar LOST sem transformar typo/nome ambíguo em dinheiro.
 * A ordem e o `playerId` do gol vêm exclusivamente do summary validado.
 */
export function resolveOrderedGoalscorer(params: {
  selecao: string;
  mercado: string;
  jogadores: readonly JogadorDaPartida[];
  gols: readonly OrderedGoal[];
}): OrderedGoalscorerResolution {
  const ordem = orderedGoalscorerMarketOrder(params.mercado, params.selecao);
  if (!ordem) return { ok: false, reason: "mercado_sem_ordem" };
  if (hasUnsupportedGoalQualifier(params.mercado, params.selecao)) {
    return { ok: false, reason: "qualificador_sem_contrato" };
  }
  if (temPolaridadeNegativa(params.selecao, params.mercado)) {
    return { ok: false, reason: "polaridade_negativa" };
  }
  if (params.gols.length === 0) return { ok: false, reason: "sem_gols" };

  const match = encontrarJogadorNaPartida(params.selecao, params.jogadores);
  if (!match.ok) return match;
  // Primeiro/último a marcar é UM gol; "2+" ou grafia de quantidade aqui não
  // tem leitura segura.
  if (requiredPlayerGoals(params.mercado, params.selecao) !== 1) {
    return { ok: false, reason: "quantidade_de_gols_desconhecida" };
  }
  const jogadorDoGol = ordem === "first" ? params.gols[0] : params.gols.at(-1);
  if (!jogadorDoGol) return { ok: false, reason: "sem_gols" };
  const jogadorDoRoster = params.jogadores.find(
    (jogador) => jogador.playerId === jogadorDoGol.playerId,
  );
  if (!jogadorDoRoster) {
    return { ok: false, reason: "jogador_do_gol_ausente" };
  }
  const status = listedButDidNotPlay(match.jogador)
    ? "VOID"
    : match.jogador.playerId === jogadorDoGol.playerId ? "WON" : "LOST";
  if (status === "LOST" && participationUnproven(match.jogador)) {
    return { ok: false, reason: "participacao_nao_comprovada" };
  }
  if (status === "LOST" && ordem === "first" && !onPitchBeforeGoal(match.jogador, jogadorDoGol.minuto)) {
    return { ok: false, reason: "entrada_apos_primeiro_gol_nao_descartada" };
  }
  return {
    ok: true,
    ordem,
    status,
    jogadorSelecionado: match.jogador,
    jogadorDoGol: {
      ...jogadorDoGol,
      nome: jogadorDoRoster.nome,
      ...(jogadorDoRoster.nomeCurto ? { nomeCurto: jogadorDoRoster.nomeCurto } : {}),
    },
    similaridade: match.similaridade,
    vantagem: match.vantagem,
  };
}

const GOALS_WORD = String.raw`(?:\s*(?:gols?|goals?))?`;
// Globais só com `replace`, que recomeça do início do texto a cada chamada.
const N_OR_MORE = new RegExp(String.raw`(?<![\d.,])(\d{1,2})\s*(?:ou|or)\s*(?:mais|more)\b${GOALS_WORD}`, "g");
const AT_LEAST_N = new RegExp(String.raw`\b(?:pelo menos|no minimo|at least)\s*(\d{1,2})\b${GOALS_WORD}`, "g");
const N_PLUS = new RegExp(String.raw`(?<![\d.,])(\d{1,2})\s*\+${GOALS_WORD}`, "g");

/**
 * Quantos gols do jogador a aposta pede, lidos do mercado e da seleção: "2+",
 * "3+ gols", "N ou mais", "N or more", "pelo menos N", "N gols", "hat-trick"
 * (3) e "brace"/"bis" (2). Sem quantidade, é marcar (1). Qualquer número ou
 * quantidade que sobre sem leitura ("over 1.5", "dois gols", duas quantidades
 * diferentes) devolve null: grafia desconhecida vai para o operador, nunca
 * vira "marcar" por omissão.
 */
export function requiredPlayerGoals(mercado: string, selecao: string): number | null {
  let text = ` ${normalizeStr(`${mercado} ${selecao}`)} `
    // Período e ordem são outra pergunta, com resolvedor próprio: tiram-se os
    // números deles antes de procurar a quantidade.
    .replace(/\b[12]\s*[ºª°o]?\s*(?:tempo|etapa|parte|half)\b/g, " ")
    .replace(/\b(?:1st|2nd|3rd|first|second|last|primeir[oa]|segund[oa]|ultim[oa])\b/g, " ")
    .replace(/\b[12]\s*[ºª°]/g, " ")
    .replace(/\b(?:[12]t|h[12]|[12]h)\b/g, " ");
  const found = new Set<number>();
  const take = (pattern: RegExp, value: (match: string[]) => number) => {
    text = text.replace(pattern, (...match: string[]) => {
      found.add(value(match));
      return " ";
    });
  };
  take(/\bhat\s*-?\s*tricks?\b|\bhattricks?\b/g, () => 3);
  take(/\b(?:brace|bis)\b/g, () => 2);
  take(N_OR_MORE, (m) => Number(m[1]));
  take(AT_LEAST_N, (m) => Number(m[1]));
  take(N_PLUS, (m) => Number(m[1]));
  take(/(?<![\d.,])(\d{1,2})\s*(?:gols?|goals?)\b/g, (m) => Number(m[1]));
  if (/\d/.test(text)) return null;
  if (/\b(?:over|under|mais de|menos de|acima de|abaixo de|exatamente|exactly|dois|duas|tres|quatro|two|three|four|poker|doblete|triplete)\b/.test(text)) {
    return null;
  }
  if (found.size > 1) return null;
  const [goals] = [...found];
  if (goals === undefined) return 1;
  return goals >= 1 ? goals : null;
}

/**
 * Resolve o mercado. Liquida `WON` quando o jogador casado tem `gols > 0` e
 * `LOST` quando tem zero — a ausência de gol é informação positiva aqui: a
 * lista de jogadores da partida encerrada é completa, então "não está com gol"
 * significa "não marcou", diferente de estatística que o feed omite.
 */
export function resolveGoalscorer(params: {
  selecao: string;
  mercado?: string;
  jogadores: readonly JogadorDaPartida[];
}): GoalscorerResolution {
  // O qualificador vem antes do período: "nos dois tempos" também tem período
  // OTHER, e o motivo que o dono lê no alerta é o qualificador.
  if (hasUnsupportedGoalQualifier(params.mercado ?? "", params.selecao)) {
    return { ok: false, reason: "qualificador_sem_contrato" };
  }
  if (
    marketPeriodOf(params.selecao) !== "FT" ||
    (params.mercado && marketPeriodOf(params.mercado) !== "FT")
  ) {
    return { ok: false, reason: "periodo_nao_suportado" };
  }
  if (temPolaridadeNegativa(params.selecao, params.mercado)) {
    return { ok: false, reason: "polaridade_negativa" };
  }
  const match = encontrarJogadorNaPartida(params.selecao, params.jogadores);
  if (!match.ok) return match;
  if (match.jogador.golsContra > 0) {
    return { ok: false, reason: "gol_contra_envolvido" };
  }
  const minGols = requiredPlayerGoals(params.mercado ?? "", params.selecao);
  if (minGols === null) return { ok: false, reason: "quantidade_de_gols_desconhecida" };
  if (listedButDidNotPlay(match.jogador)) {
    return { ok: true, status: "VOID", jogador: match.jogador, similaridade: match.similaridade, vantagem: match.vantagem };
  }
  if (participationUnproven(match.jogador)) {
    return { ok: false, reason: "participacao_nao_comprovada" };
  }
  return {
    ok: true,
    status: match.jogador.gols >= minGols ? "WON" : "LOST",
    jogador: match.jogador,
    similaridade: match.similaridade,
    vantagem: match.vantagem,
  };
}
