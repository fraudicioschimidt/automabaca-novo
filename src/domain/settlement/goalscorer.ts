import dominio from "@automabaca/dominio";
import { marketPeriodOf } from "@/src/domain/mercados/classify";
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

/**
 * Artilheiro que o FlashScore sabe resolver: só ANYTIME. First/Last exigem a
 * ordem do gol, que a lista de jogadores não traz. As regras de texto moram
 * em Rust (`rust/crates/dominio/src/settlement/goalscorer.rs`).
 */
export function ehMercadoArtilheiro(mercado: string, selecao?: string): boolean {
  return dominio.ehMercadoArtilheiro(mercado, selecao);
}

/**
 * Mercado de gol de jogador em 1º ou 2º TEMPO: a prova é o minuto do gol, no
 * resumo da partida, não a estatística agregada.
 */
export function ehMercadoArtilheiroPorTempo(mercado: string, selecao?: string): boolean {
  return dominio.ehMercadoArtilheiroPorTempo(mercado, selecao);
}

/**
 * Qualificador que troca "marcou?" por uma pergunta que a lista de jogadores
 * não responde: gol de cabeça, de fora da área, de pênalti ou de falta, nos
 * dois tempos, ou o gol combinado com outra coisa.
 */
export function hasUnsupportedGoalQualifier(mercado: string, selecao = ""): boolean {
  return dominio.hasUnsupportedGoalQualifier(mercado, selecao);
}

export type OrderedGoalscorerOrder = "first" | "last";

/**
 * First/Last são outra família de settlement: `GOALS` prova quantidade, mas
 * não ordem. O rótulo precisa declarar inequivocamente primeiro ou último do jogo inteiro.
 */
export function orderedGoalscorerMarketOrder(
  mercado: string,
  selecao?: string,
): OrderedGoalscorerOrder | null {
  return dominio.orderedGoalscorerMarketOrder(mercado, selecao);
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
  return dominio.minutoBase(raw);
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

/**
 * Quantos gols do jogador a aposta pede, lidos do mercado e da seleção: "2+",
 * "3+ gols", "N ou mais", "pelo menos N", "hat-trick" (3), "brace"/"bis" (2).
 * Sem quantidade, é marcar (1). Grafia sem leitura devolve null: vai para o
 * operador, nunca vira "marcar" por omissão.
 */
export function requiredPlayerGoals(mercado: string, selecao: string): number | null {
  return dominio.requiredPlayerGoals(mercado, selecao);
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
