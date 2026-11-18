import { marketPeriodOf } from "@/src/domain/mercados/classify";
import {
  encontrarJogadorNaPartida,
  listedButDidNotPlay,
  participationUnproven,
  temPolaridadeNegativa,
  type GoalscorerRefusal,
  type JogadorDaPartida,
} from "./goalscorer-matching";
import {
  hasUnsupportedGoalQualifier,
  minutoBase,
  requiredPlayerGoals,
  type OrderedGoal,
} from "./goalscorer";

/**
 * "Fulano marcar no 1º tempo" — o gol existe, mas não no lugar onde o resolvedor
 * de tempo integral procura.
 *
 * As estatísticas por jogador do FlashScore são TODAS do jogo inteiro
 * (conferido no payload real): não há recorte por tempo. Quem
 * sabe o minuto de cada gol é o RESUMO da partida, que o projeto já lê para
 * decidir primeiro e último gol. Este resolvedor junta as duas fontes.
 */
export type PeriodGoalscorerRefusal =
  | GoalscorerRefusal
  | "quantidade_de_gols_desconhecida"
  | "qualificador_sem_contrato"
  | "periodo_nao_reconhecido"
  /** O resumo não explica todos os gols que a estatística atribui ao jogador. */
  | "gols_inconsistentes";

export type PeriodGoalscorerResolution =
  /** VOID: o jogador estava no elenco e não entrou. */
  | { ok: true; status: "WON" | "LOST" | "VOID"; jogador: JogadorDaPartida; golsNoPeriodo: number }
  | { ok: false; reason: PeriodGoalscorerRefusal };

/**
 * Prorrogação NÃO conta como segundo tempo: o mercado de 2º tempo é dos 45
 * minutos regulamentares, e somar o tempo extra inverteria resultado.
 */
export function periodoDoMinuto(raw: string): "HT" | "SECOND_HALF" | "OTHER" | null {
  const base = minutoBase(raw);
  if (base === null) return null;
  if (base <= 45) return "HT";
  if (base <= 90) return "SECOND_HALF";
  return "OTHER";
}

export function resolvePeriodGoalscorer(params: {
  selecao: string;
  mercado?: string;
  jogadores: readonly JogadorDaPartida[];
  /** Gols do resumo, em ordem, com o minuto cru ("45+2"). */
  gols: readonly OrderedGoal[];
  periodo: "HT" | "SECOND_HALF";
}): PeriodGoalscorerResolution {
  if (params.periodo !== "HT" && params.periodo !== "SECOND_HALF") {
    return { ok: false, reason: "periodo_nao_reconhecido" };
  }
  if (hasUnsupportedGoalQualifier(params.mercado ?? "", params.selecao)) {
    return { ok: false, reason: "qualificador_sem_contrato" };
  }
  // A linha que NEGA o gol inverteria o resultado se liquidada pelo gol.
  if (temPolaridadeNegativa(params.selecao, params.mercado)) {
    return { ok: false, reason: "polaridade_negativa" };
  }
  if (marketPeriodOf(params.selecao) === "OTHER" || (params.mercado && marketPeriodOf(params.mercado) === "OTHER")) {
    return { ok: false, reason: "periodo_nao_reconhecido" };
  }
  // "2+ gols no 1º tempo" pede dois gols no período, não um.
  const needed = requiredPlayerGoals(params.mercado ?? "", params.selecao);
  if (needed === null) return { ok: false, reason: "quantidade_de_gols_desconhecida" };
  const match = encontrarJogadorNaPartida(params.selecao, params.jogadores);
  if (!match.ok) return match;
  const jogador = match.jogador;
  if (jogador.golsContra > 0) return { ok: false, reason: "gol_contra_envolvido" };
  if (listedButDidNotPlay(jogador)) return { ok: true, status: "VOID", jogador, golsNoPeriodo: 0 };

  const dele = params.gols.filter((gol) => gol.playerId === jogador.playerId);
  // O resumo precisa explicar TODOS os gols que a estatística dá ao jogador.
  // Um gol sem minuto legível viraria "não marcou no 1º tempo" sem prova.
  if (dele.length !== jogador.gols) return { ok: false, reason: "gols_inconsistentes" };
  const periodos = dele.map((gol) => periodoDoMinuto(gol.minuto));
  if (periodos.some((periodo) => periodo === null)) return { ok: false, reason: "gols_inconsistentes" };
  const golsNoPeriodo = periodos.filter((periodo) => periodo === params.periodo).length;
  if (participationUnproven(jogador)) {
    return { ok: false, reason: "participacao_nao_comprovada" };
  }
  return { ok: true, status: golsNoPeriodo >= needed ? "WON" : "LOST", jogador, golsNoPeriodo };
}
