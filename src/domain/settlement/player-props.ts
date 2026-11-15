import { hasUnsupportedPlayerPropQualifier, normalizePlayerThreshold, playerPropLineQuarters } from "./player-prop-terms";
import { totalDirectionOf } from "@/src/domain/mercados/total-direction";
import { statusFromAdjustedQuarters, extractSignedNumbers } from "@/src/domain/settlement/lines";
import {
  encontrarJogadorNaPartida,
  temPolaridadeNegativa,
  type JogadorDaPartida,
  type PlayerNameMatch,
} from "@/src/domain/settlement/goalscorer-matching";
import {
  chaveDaProp,
  classificarPropDeJogador,
  valorDaProp,
  type PlayerPropFamily,
} from "@/src/domain/settlement/player-prop-classify";
import type { BetStatus } from "@/src/domain/bet-status";

export type PlayerPropRefusal =
  | Exclude<PlayerNameMatch<JogadorDaPartida>, { ok: true }>["reason"]
  | "nao_e_prop_de_jogador"
  | "stat_ausente"
  | "jogador_nao_participou"
  | "participacao_nao_comprovada"
  | "periodo_nao_suportado"
  | "convencao_de_cartoes_ambigua"
  | "qualificador_sem_contrato"
  | "missing_line"
  | "ambiguous_selection";

export type PlayerPropResolution =
  | {
      ok: true;
      status: BetStatus;
      family: PlayerPropFamily;
      chave: string;
      valor: number;
      jogador: JogadorDaPartida;
      similaridade: number;
      vantagem: number;
    }
  | { ok: false; reason: PlayerPropRefusal; candidatos?: string[] };

/**
 * Over/under da estatística do jogador casado. Chave ausente, nome ambíguo
 * ou linha ilegível recusam — nunca chutam zero nem caem no placar.
 */
export function resolvePlayerProp(params: {
  mercado: string;
  selecao: string;
  evento?: string;
  esporte?: string;
  jogadores: readonly JogadorDaPartida[];
}): PlayerPropResolution {
  const cls = classificarPropDeJogador(params);
  if (!cls) return { ok: false, reason: "nao_e_prop_de_jogador" };
  // O endpoint publica só o agregado da partida. HT/2H/qualquer outra fase
  // precisa de evidência equivalente antes de poder decidir dinheiro.
  if (cls.period) return { ok: false, reason: "periodo_nao_suportado" };
  if (hasUnsupportedPlayerPropQualifier(params.mercado, params.selecao)) {
    return { ok: false, reason: "qualificador_sem_contrato" };
  }
  const match = encontrarJogadorNaPartida(params.selecao, params.jogadores);
  if (!match.ok) return match;
  if (
    match.jogador.minutosJogados !== undefined &&
    match.jogador.minutosJogados <= 0 && match.jogador.participou !== true
  ) {
    return { ok: false, reason: "jogador_nao_participou" };
  }
  const stats = match.jogador.stats ?? {};
  // "Cartões" sem cor depende da regra da casa. Mesmo com as três chaves do
  // provider, não há convenção única segura para somar vermelho/2º amarelo.
  if (cls.family === "cards_any") {
    return { ok: false, reason: "convencao_de_cartoes_ambigua" };
  }
  if (cls.family === "cards_yellow" || cls.family === "cards_red") {
    const segundoAmarelo = stats["CARDS_YELLOW_SECOND"];
    if (segundoAmarelo === undefined) return { ok: false, reason: "stat_ausente" };
    if (segundoAmarelo > 0) {
      return { ok: false, reason: "convencao_de_cartoes_ambigua" };
    }
  }
  const valor = valorDaProp(cls.family, stats);
  if (valor === undefined) return { ok: false, reason: "stat_ausente" };
  // Estatística positiva prova que o atleta entrou. Zero, sozinho, não separa
  // desempenho de um reserva que ficou no banco; nesse caso minutos são a prova.
  if (valor === 0 && match.jogador.minutosJogados === undefined && match.jogador.participou !== true) {
    return { ok: false, reason: "participacao_nao_comprovada" };
  }
  const explicitLineQ = playerPropLineQuarters(params.selecao);
  const explicitDirection = totalDirectionOf(normalizePlayerThreshold(params.selecao), { allowBarePositiveLine: true });
  // "Neymar - Não" não é só o nome: o casamento corta o " - Não", e o Over
  // 0.5 padrão abaixo inverteria a aposta. Com direção escrita ("Over 1.5
  // chutes no gol") o "no" é preposição e a linha manda.
  if (explicitDirection === null && temPolaridadeNegativa(params.selecao, params.mercado)) {
    return { ok: false, reason: "ambiguous_selection" };
  }

  // Mercados nominais de ocorrência individual (ex.: "Player Assists", "Player Red Card", "Player Yellow Card"):
  // quando o tipster/casa envia apenas o nome do atleta sem linha explícita, a convenção padrão é Over 0.5 (≥ 1).
  const isDefaultOver05Prop =
    cls.family === "assists" ||
    cls.family === "cards_yellow" ||
    cls.family === "cards_red";
  // Padrão nominal só quando não houve tentativa de escrever linha/direção.
  const nominal = isDefaultOver05Prop && [params.mercado, params.selecao].every((text) =>
    extractSignedNumbers(text).length === 0
    && !/\b(?:over|under|mais|menos|acima|abaixo|above|below)\b/i.test(text));
  const lineQ = explicitLineQ ?? (nominal ? 2 : null);
  const direction = explicitDirection ?? (nominal ? "over" : null);

  if (lineQ === null) return { ok: false, reason: "missing_line" };
  if (!direction) return { ok: false, reason: "ambiguous_selection" };
  const totalQ = 4 * valor;
  const adjustedQ = direction === "over" ? totalQ - lineQ : lineQ - totalQ;
  return {
    ok: true,
    status: statusFromAdjustedQuarters(adjustedQ),
    family: cls.family,
    chave: chaveDaProp(cls.family),
    valor,
    jogador: match.jogador,
    similaridade: match.similaridade,
    vantagem: match.vantagem,
  };
}
