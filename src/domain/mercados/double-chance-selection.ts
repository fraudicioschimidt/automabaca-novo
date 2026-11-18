import { normalizeStr, splitEventoTeams } from "@/src/domain/text";
import { matchDoubleChanceSelection, matchTeamSide } from "@/src/domain/settlement/sides";
import { marketIncludesExtraTime, marketKindOf, marketPeriodOf } from "./classify";
import { restrictsToRegulationTime } from "./compatibility";
import { stripDoubleChanceFromSelection } from "./draw-vocabulary";
import { hasNonScoreStatQualifier, hasScoreUnitMismatch } from "./stat-qualifier";

/** Linha de handicap na seleção ("Time +1", "Time -0.5"). */
const HANDICAP_LINE = /\+\s*\d|(?:^|\s)[−–-]\s*\d/;

/**
 * Resolve a abreviação enquanto o evento ainda contém o nome da mensagem.
 * O token X2/1X/12 atravessa aliases sem perder lado nem a cobertura do empate.
 */
export function canonicalDoubleChanceSelection(input: {
  evento: string;
  mercado: string;
  selecao: string;
  esporte: string;
}): { mercado: string; selecao: string } | null {
  // O token compacto não carrega a regra de prorrogação/regulamentar.
  if ([input.mercado, input.selecao].some(text => marketIncludesExtraTime(text) ||
    restrictsToRegulationTime(text, input.esporte))) return null;
  const teams = splitEventoTeams(input.evento);
  const kind = marketKindOf(input.mercado);
  const original = normalizeStr(input.selecao);
  const isTeamName = teams && [teams.home, teams.away].some(team => normalizeStr(team) === original);
  // "DC United" e "Washington DC" podem ser nomes inteiros, não rótulos.
  const marker = isTeamName
    ? { isDc: false, cleanTeam: input.selecao }
    : stripDoubleChanceFromSelection(input.selecao);
  if (kind !== "double_chance" && !marker.isDc) return null;
  if (kind !== "double_chance" && (
    !["moneyline", "other"].includes(kind) || marketPeriodOf(input.mercado) !== "FT" ||
    hasNonScoreStatQualifier(input.mercado, input.selecao) ||
    hasScoreUnitMismatch(input.mercado, input.selecao, input.esporte)
  )) return null;
  // Não apagar um período declarado apenas na seleção.
  if (marketPeriodOf(input.selecao) !== "FT") return null;
  const mercado = kind === "double_chance" ? input.mercado : "Double Chance";
  const selection = marker.cleanTeam;
  const compact = normalizeStr(selection);
  const literalTeam = teams && [teams.home, teams.away].some(team => normalizeStr(team) === compact);
  if (HANDICAP_LINE.test(selection) && !literalTeam && !/^[12x]\s*\+\s*[12x]$/.test(compact)) {
    return { mercado, selecao: input.selecao };
  }
  const covered = matchDoubleChanceSelection(selection, input.evento);
  if (covered) return {
    mercado,
    selecao: covered.includes("draw") ? (covered.includes("home") ? "1X" : "X2") : "12",
  };

  const side = compact === "1" ? "home" : compact === "2" ? "away" : matchTeamSide(selection, input.evento);
  if (side && teams) {
    const team = side === "home" ? teams.home : teams.away;
    const tokens = (text: string) => normalizeStr(text).match(/[\p{L}\p{N}]+/gu) ?? [];
    const selectedTokens = tokens(selection);
    const teamTokens = new Set(tokens(team));
    const otherTokens = new Set(tokens(side === "home" ? teams.away : teams.home));
    // matchTeamSide também aceita nomes dentro de frases. Aqui somente o
    // nome/abreviação ou um lado explícito autoriza acrescentar o empate.
    const namesOnly = selectedTokens.length > 0 && selectedTokens.every(token => teamTokens.has(token)) &&
      !selectedTokens.every(token => otherTokens.has(token));
    const sideOnly = /^(?:1|2|home|away|casa|fora|mandante|visitante)$/.test(compact);
    const hasLine = HANDICAP_LINE.test(selection) && compact !== normalizeStr(team);
    if (!hasLine && (namesOnly || sideOnly)) return { mercado, selecao: side === "home" ? "1X" : "X2" };
  }
  // Ambiguidade permanece visível; não remover o marcador que explica a tip.
  return { mercado, selecao: input.selecao };
}
