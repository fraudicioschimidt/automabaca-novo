import { flashscoreSportPerfil } from "./sports";
import type { FlashscoreMatch } from "./types";

/**
 * Decide se uma partida do FlashScore pode ser considerada ENCERRADA, por dois
 * caminhos:
 *
 * 1. **Flag** — futebol, tênis, basquete e hóquei. O fornecedor afirma o fim.
 * 2. **Inferência** — os demais (`modo: "inferido"` em `sports.ts`). O `scores`
 *    é `null` enquanto o jogo não aconteceu e aparece depois; o fim é deduzido
 *    de placar presente + tempo decorrido + placar ESTÁVEL.
 *
 * A inferência é fail-closed em três frentes porque liquidar cedo é dinheiro
 * invertido, enquanto liquidar tarde só custa latência.
 */

export type ObservacaoAnterior = {
  /** Placar visto na observação anterior, no formato "HxA". */
  readonly placar: string;
  /**
   * Quando ESTE placar apareceu pela PRIMEIRA vez — não quando foi lido pela
   * última.
   *
   * O job reobserva em intervalo menor que a janela de estabilidade: ancorado
   * na última leitura, a distância seria sempre um ciclo e a inferência nunca
   * liquidaria. Ancorado na PRIMEIRA aparição, o portão abre uma janela depois
   * de o placar parar de mudar — independente de com que frequência a gente olha.
   */
  readonly desde: Date;
};

export type DecisaoTerminal =
  | { terminal: true; via: "flag" | "inferencia" }
  | { terminal: false; motivo: MotivoNaoTerminal };

export type MotivoNaoTerminal =
  | "esporte_desconhecido"
  | "esporte_sem_placar_utilizavel"
  | "sem_placar"
  | "cedo_demais"
  | "sem_confirmacao"
  | "placar_mudou";

/**
 * Há quanto tempo o placar precisa estar PARADO para valer como final. Menor que
 * isto não prova estabilidade: o job roda a cada 10min e duas leituras coladas
 * pegariam o mesmo instante do jogo.
 */
export const CONFIRMACAO_MIN_MS = 30 * 60_000;

/** Formato canônico de comparação — string porque o que importa é MUDOU ou não. */
export function chavePlacar(match: FlashscoreMatch): string | null {
  const { home, away } = match.scores;
  return home === null || away === null ? null : `${home}x${away}`;
}

/**
 * Partida que acabou sem ser jogada até o fim: abandono no tênis, W.O.,
 * resultado decidido fora de campo e jogo interrompido.
 *
 * O feed marca `is_finished` nas três primeiras e lista o placar do momento da
 * interrupção (sets 1-1, 0-0…), sem dizer quem abandonou. Liquidar por esse
 * placar paga errado: "Match Winner" 1-1 sai LOST para os dois lados e "Under
 * 2.5 sets" sai WON. A regra de cada casa para abandono e W.O. também varia
 * (vencedor, VOID, "pelo menos um set"), então a decisão é do operador.
 *
 * Grafias reais do catálogo em produção: "Finished / retired", "Walkover",
 * "Awarded" e "Abandoned". "Interrupted" e "Suspended" são as grafias do
 * FlashScore para jogo parado que ainda pode ser retomado; o cache de
 * produção não tinha nenhum em 23/09.
 */
export type InterruptedFinish = "retired" | "walkover" | "awarded" | "abandoned" | "interrupted";

export function interruptedFinishOf(stage: string | null | undefined): InterruptedFinish | null {
  const text = (stage ?? "").toLowerCase();
  if (/\bretired\b|\bretirement\b/.test(text)) return "retired";
  if (/\bwalk\s*-?\s*over\b|(?:^|[^a-z])w\s*\.?\s*o\b\.?/.test(text)) return "walkover";
  if (/\bawarded\b/.test(text)) return "awarded";
  if (/\babandon/.test(text)) return "abandoned";
  if (/\binterrupt|\bsuspend/.test(text)) return "interrupted";
  return null;
}

function temFlagTerminal(match: FlashscoreMatch): boolean {
  const s = match.match_status;
  return s.is_finished || s.is_finished_after_extra_time === true ||
    s.is_finished_after_penalties === true;
}

export function decidirTerminal(params: {
  match: FlashscoreMatch;
  sportId: number;
  agora: Date;
  anterior?: ObservacaoAnterior | null;
}): DecisaoTerminal {
  const perfil = flashscoreSportPerfil(params.sportId);
  if (!perfil) return { terminal: false, motivo: "esporte_desconhecido" };

  if (perfil.modo === "flag") {
    return temFlagTerminal(params.match)
      ? { terminal: true, via: "flag" }
      : { terminal: false, motivo: "sem_confirmacao" };
  }

  if (perfil.modo === "nenhum") {
    return { terminal: false, motivo: "esporte_sem_placar_utilizavel" };
  }

  // ── Inferência ──
  // 1ª trava: sem placar não há o que liquidar. Cobre jogo futuro, adiado e os
  // esportes cujo `scores` vem como string de método (boxe/MMA viram null).
  const placar = chavePlacar(params.match);
  if (placar === null) return { terminal: false, motivo: "sem_placar" };

  // 2ª trava: portão de duração. É a defesa PRINCIPAL — a medição flagrou placar
  // parcial em handebol a kickoff+89min e em críquete a +179min.
  const decorridoMs = params.agora.getTime() - params.match.timestamp * 1_000;
  if (decorridoMs < (perfil.esperaMs ?? Infinity)) {
    return { terminal: false, motivo: "cedo_demais" };
  }

  // 3ª trava: estabilidade. O portão sozinho não cobre jogo que atrasou ou
  // entrou em prorrogação; exigir que o placar esteja PARADO há meia hora fecha
  // essa fresta — e a âncora é a primeira aparição dele, não a última leitura
  // (ver `ObservacaoAnterior.desde`).
  const anterior = params.anterior;
  if (!anterior) return { terminal: false, motivo: "sem_confirmacao" };
  if (anterior.placar !== placar) return { terminal: false, motivo: "placar_mudou" };
  if (params.agora.getTime() - anterior.desde.getTime() < CONFIRMACAO_MIN_MS) {
    return { terminal: false, motivo: "sem_confirmacao" };
  }

  return { terminal: true, via: "inferencia" };
}
