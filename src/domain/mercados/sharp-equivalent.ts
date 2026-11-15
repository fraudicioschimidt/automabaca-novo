import {
  matchDrawNoBetSelection,
  matchDoubleChanceSelection,
} from "@/src/domain/settlement/sides";
import { canonicalSport } from "@/src/domain/sports/registry";
import { splitEventoTeams } from "@/src/domain/text";
import { marketIncludesExtraTime, marketKindOf, marketPeriodOf } from "./classify";
import { restrictsToRegulationTime } from "./compatibility";

export type SharpEquivalentBet = {
  mercado: string;
  selecao: string;
  nota: "dnb→ah_0.0" | "dc→ah_+0.5";
};

/** Sem esporte confirmado ou com regras distintas de retirada, não há equivalência comprovada. */
export function supportsSharpEquivalence(esporte?: string): boolean {
  const sport = canonicalSport(esporte);
  return esporte === undefined || (sport !== null && sport !== "Tennis" && sport !== "Table Tennis");
}

function dcSide(selecao: string, evento: string): "home" | "away" | null {
  const covers = matchDoubleChanceSelection(selecao, evento);
  if (!covers) return null;
  if (covers.includes("home") && covers.includes("draw")) return "home";
  if (covers.includes("away") && covers.includes("draw")) return "away";
  return null; // 12/casa+fora não tem equivalente AH de lado único.
}

/**
 * Tradução para o mercado equivalente quotável quando o original não existe
 * nos feeds. Null = sem equivalente (segue o fluxo normal).
 */
export function sharpEquivalentBet(params: {
  mercado: string;
  selecao: string;
  evento: string;
  esporte?: string;
}): SharpEquivalentBet | null {
  if (!supportsSharpEquivalence(params.esporte)) return null;
  const kind = marketKindOf(params.mercado, params.selecao, params.evento);
  // Mercado e seleção são duas superfícies da mesma evidência. Traduzir um
  // DNB parcial para AH 0.0 FT fabricaria uma linha que não foi apostada.
  if (
    marketPeriodOf(params.mercado) !== "FT" ||
    marketPeriodOf(params.selecao) !== "FT" ||
    [params.mercado, params.selecao].some(text => restrictsToRegulationTime(text, params.esporte))
  ) return null;
  const market = [params.mercado, params.selecao].some(marketIncludesExtraTime)
    ? "Asian Handicap – Including Overtime" : "Asian Handicap";
  const teams = splitEventoTeams(params.evento);
  if (!teams) return null;

  if (kind === "draw_no_bet") {
    const side = matchDrawNoBetSelection(params.selecao, params.evento);
    if (!side) return null;
    const team = side === "home" ? teams.home : teams.away;
    return { mercado: market, selecao: `${team} 0.0`, nota: "dnb→ah_0.0" };
  }

  if (kind === "double_chance") {
    const side = dcSide(params.selecao, params.evento);
    if (!side) return null;
    const team = side === "home" ? teams.home : teams.away;
    return { mercado: market, selecao: `${team} +0.5`, nota: "dc→ah_+0.5" };
  }

  return null;
}

/** Aposta efetiva para PRECIFICAÇÃO: original, ou o equivalente AH. */
export function effectiveSharpBet(params: {
  mercado: string;
  selecao: string;
  evento: string;
  esporte?: string;
}): { mercado: string; selecao: string } {
  const eq = sharpEquivalentBet(params);
  return eq ?? { mercado: params.mercado, selecao: params.selecao };
}
