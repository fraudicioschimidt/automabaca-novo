import { isThreeWayHandicapMarket, marketKindOf } from "./classify";
import { finalizePinnacleMarket, keepDeclaredPeriod, pinnacleizeMercado } from "./finalize";
import {
  declaresEuropeanHandicap,
  selecaoNomeiaTimeDoTotal,
  selecaoPareceHandicap,
  stripSelectionOdds,
} from "./selection-shape";
import { looksLikeTotalSelection } from "./total-direction";
import { hasNonScoreStatQualifier, hasScoreUnitMismatch } from "./stat-qualifier";
import { inferPinnacleStatMarket } from "./stat-unit";
import { isCombinedSelection } from "./selecao";
import { classificarPropDeJogador } from "@/src/domain/settlement/player-prop-classify";
import { normalizeStr } from "@/src/domain/text";

/** Tokens compactos de Dupla Chance que não dependem do evento para serem lidos. */
const DUPLA_CHANCE_COMPACTA = /^(?:1x|x1|x2|2x|12|21)$/;

/** Rótulo do handicap europeu que a seleção declarou e o mercado não. */
const EUROPEAN_HANDICAP = "European Handicap";

/**
 * Seleção O/U com linha NUNCA é Moneyline — tipster abreviou ("U 4.5") e o
 * mercado veio errado ou ausente; sem a coerção, "Moneyline · U 4.5" fica
 * impreçável.
 *
 * Também coage mercado DESCONHECIDO (kind "other", ex. Bet365 "Gols + -")
 * quando a seleção tem cara de Total — senão BridgeOdds cai em
 * unsupported_market e o alerta grava "mercado não reconhecido".
 *
 * A coerção corrige a FAMÍLIA do mercado, nunca o período que o rótulo
 * declara; o 1º tempo que só a seleção declara vai para o mercado
 * (`keepDeclaredPeriod`).
 */
export function coerceMercadoPelaSelecao(
  mercado: string,
  selecao: string,
  esporte?: string,
  evento?: string,
): string {
  return keepDeclaredPeriod(mercado, coerceMarketFamily(mercado, selecao, esporte, evento), esporte, selecao);
}

function coerceMarketFamily(
  mercado: string,
  selecao: string,
  esporte?: string,
  evento?: string,
): string {
  selecao = stripSelectionOdds(selecao);
  // A combinada ("Flamengo e Over 1.5") não é de uma família só: escolher uma
  // pela seleção gravaria metade da aposta.
  if (evento && isCombinedSelection(selecao, evento)) return mercado;
  // Handicap europeu dito só na seleção ("Flamengo -1 (Handicap Europeu)"):
  // no europeu a cobertura exata perde, no asiático devolve. O rótulo
  // asiático apagaria a única evidência da diferença.
  if (declaresEuropeanHandicap(selecao)) {
    return isThreeWayHandicapMarket(mercado) ? mercado : EUROPEAN_HANDICAP;
  }
  const playerProp = classificarPropDeJogador({ mercado, selecao, evento, esporte });
  // O player-stats só publica o agregado FT. Preservar o rótulo parcial é o
  // que permite ao settlement diagnosticar e recusar, em vez de apagar HT.
  if (playerProp) return playerProp.period ? mercado : playerProp.mercado;
  // A unidade da seleção vence o rótulo genérico JÁ finalizado: `Total – Match`
  // + "Over 8.5 corners" ficava em gols porque kind `total` saía antes de
  // olhar a estatística, e o pinnacleize da seleção ainda apagava a palavra
  // "corners" — liquidava pelo placar.
  const inferred = inferPinnacleStatMarket(mercado, selecao, "", evento, esporte);
  if (inferred !== mercado) return pinnacleizeMercado(inferred, esporte);
  const kind = marketKindOf(mercado);
  // Artilheiro com seleção Over/Under ("Gol" / "Over 0.5") é total de gols: a
  // seleção de artilheiro é o nome do jogador, nunca uma direção com linha.
  if (kind === "scorer" && /^\s*(?:over|under|mais|menos|acima|abaixo)\b\s*(?:de\s+)?\+?\d/.test(normalizeStr(selecao))) {
    return finalizePinnacleMarket("Total", esporte);
  }
  // Total genérico cuja seleção nomeia um time é total DO TIME.
  if (kind === "total" && evento && !hasNonScoreStatQualifier(mercado, selecao) &&
    selecaoNomeiaTimeDoTotal(selecao, evento)) {
    return finalizePinnacleMarket("Team Total", esporte);
  }
  if (kind !== "moneyline" && kind !== "other") return mercado;
  // "1X"/"X2"/"12" num mercado Moneyline: o parser de Dupla Chance entende a
  // seleção, mas o mercado dizia 1X2 e a aposta morria em `ambiguous_selection`
  // a cada ciclo. Os compactos não dependem do evento — "1X" não é
  // nome de time nem linha.
  if (DUPLA_CHANCE_COMPACTA.test(normalizeStr(selecao).replace(/[^a-z0-9]/g, ""))) {
    return finalizePinnacleMarket("Double Chance", esporte);
  }
  // Mercado que DECLARA uma estatística nunca é reescrito: "Linha de
  // Finalizações / Over 4.5" virava `Total – Match` e, sem a palavra
  // "finalizações", o gate de estatística do settlement não tinha mais o que
  // detectar — a aposta liquidava pelo placar de GOLS. O rótulo do tipster é a
  // única evidência da unidade; apagá-lo é perder a informação, não normalizar.
  if (hasNonScoreStatQualifier(mercado, selecao)) return mercado;
  // Mesma razão para a unidade que não é o placar DESTE esporte: "Corridas -
  // Jogo" em futebol virava `Total – Match` e liquidava por gols.
  if (hasScoreUnitMismatch(mercado, selecao, esporte)) return mercado;
  if (looksLikeTotalSelection(selecao)) {
    return finalizePinnacleMarket(
      evento && selecaoNomeiaTimeDoTotal(selecao, evento) ? "Team Total" : "Total",
      esporte,
    );
  }
  // Handicap EUROPEU não vira asiático. O europeu é de 3 vias e não tem push:
  // cobertura exata (-1 num 1-0) é DERROTA, enquanto o asiático devolve a
  // aposta. Reescrever o rótulo apagava a única evidência dessa diferença e o
  // settlement liquidava VOID onde a casa paga LOST. Mesma regra do
  // qualificador de estatística acima: rótulo que declara a mecânica fica.
  if (isThreeWayHandicapMarket(mercado)) return mercado;
  // "Negativos 2.5"/"Positivos 2.5" é vocabulário BR de total (menos/mais),
  // não handicap. A seleção "parece handicap" pelo padrão de linha e o mercado
  // virava `Asian Handicap`, jogando a aposta na matemática por lado.
  // Não coage para total sem confirmar o corpus: fica como está e o mercado
  // segue seu caminho — recusar é melhor que reescrever para o lado errado.
  if (/\b(?:negativos?|positivos?)\b/.test(normalizeStr(selecao))) return mercado;
  if (selecaoPareceHandicap(selecao)) {
    return finalizePinnacleMarket("Asian Handicap", esporte);
  }
  return mercado;
}
