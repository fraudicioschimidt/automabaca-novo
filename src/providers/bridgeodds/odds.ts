import { effectiveSharpBet } from "@/src/domain/mercados/sharp-equivalent";
import { marketKindOf, marketPeriodOf } from "@/src/domain/mercados/classify";
import { totalDirectionOf } from "@/src/domain/mercados/total-direction";
import { hasScoreUnitMismatch } from "@/src/domain/mercados/stat-qualifier";
import { autoFairProbs, powerFairOdds } from "@/src/domain/odds";
import {
  quarterPriceSnapshot,
  recomputePriceSnapshot,
  singlePriceSnapshot,
  type PriceSnapshot,
  type QuarterLineMarket,
} from "@/src/domain/price-provenance";
import { lineToQuarters, parseLineQuarters } from "@/src/domain/settlement/lines";
import {
  matchMoneylineSelection,
  resolveSideFromMarketAndSelection,
  stripTeamNames,
} from "@/src/domain/settlement/sides";
import { isStatQualifierMarket } from "@/src/providers/coverage";
import { BRIDGEODDS_COVERAGE, bridgeOddsSupportsScope } from "./coverage-contract";
import { BRIDGEODDS_CURRENT_PRICE_MAX_AGE_MS } from "./limits";
import type {
  BridgeLine,
  BridgeMatch,
  BridgeMoneylinePrices,
  BridgeTotalPrices,
  BridgeTwoWayPrices,
} from "./types";

/**
 * Odds da seleção apostada a partir de um BridgeMatch, com devig
 * (domain/odds): Moneyline, Total (FT) e Asian Handicap; quarter lines
 * combinam componentes. `opening` e `closing` (= linha atual pré-live) saem
 * juntos.
 *
 * Frescor: a barreira operacional é de 60s (`BRIDGE_CATALOG_FRESH_MS` e o
 * snapshot por match_id); `stale_price` (15min,
 * `BRIDGEODDS_CURRENT_PRICE_MAX_AGE_MS`) é o teto externo, igual ao da
 * Pinnacle17, para um snapshot reaproveitado não virar CLV velho.
 */

type PhaseOdds = {
  raw: number;
  fair: number;
  maxBet: number | null;
  snapshot: PriceSnapshot;
};

type BridgeSelectionOdds = {
  opening: PhaseOdds | null;
  current: PhaseOdds | null;
};

type ResolveOddsResult =
  | { ok: true; odds: BridgeSelectionOdds }
  | {
      ok: false;
      reason: "unsupported_market" | "ambiguous_selection" | "missing_line" | "line_mismatch" | "no_prices" | "stale_price";
    };

function moneylinePhase(
  prices: BridgeMoneylinePrices | undefined,
  pick: "home" | "away" | "draw",
  requireDraw: boolean,
): PhaseOdds | null {
  if (!prices) return null;
  const draw = prices.draw;
  // Em esporte com empate, o livro sem o draw é um 3-way quebrado: desvigado
  // como 2-way, daria uma justa inventada (a Pinnacle17 recusa o mesmo caso).
  if (draw === undefined && (requireDraw || pick === "draw")) return null;
  const list = draw !== undefined ? [prices.home, draw, prices.away] : [prices.home, prices.away];
  const probs = autoFairProbs(list);
  if (!probs) return null;
  const idx = pick === "home" ? 0 : pick === "away" ? list.length - 1 : 1;
  const raw = list[idx];
  const prob = probs[idx];
  if (raw === undefined || prob === undefined || prob <= 0) return null;
  return {
    raw,
    fair: 1 / prob,
    maxBet: prices.max_bet ?? null,
    snapshot: singlePriceSnapshot({ rawOdds: list, selectedIndex: idx, devig: "auto", maxBet: prices.max_bet }),
  };
}

function twoWayPhase(
  pair: [number, number] | null,
  pickFirst: boolean,
  maxBet: number | null,
  lineQ: number | null = null,
): PhaseOdds | null {
  if (!pair) return null;
  const fair = powerFairOdds(pair);
  if (!fair) return null;
  const idx = pickFirst ? 0 : 1;
  const raw = pair[idx];
  const fairOdd = fair[idx];
  if (raw === undefined || fairOdd === undefined) return null;
  return {
    raw,
    fair: fairOdd,
    maxBet,
    snapshot: singlePriceSnapshot({
      rawOdds: pair,
      selectedIndex: idx,
      devig: "power",
      lineQ,
      maxBet,
    }),
  };
}

function linesByQuarter<P>(lines: Array<BridgeLine<P>> | undefined): Map<number, BridgeLine<P>> {
  const map = new Map<number, BridgeLine<P>>();
  for (const line of lines ?? []) {
    const q = lineToQuarters(line.hdp_points);
    if (q !== null) map.set(q, line);
  }
  return map;
}

type LinePrices = { pair: [number, number]; maxBet: number | null };

/** Extrai fase (opening/closing) de uma linha 2-way; quarter combina componentes. */
function resolveLinePhase<P>(
  byQuarter: Map<number, BridgeLine<P>>,
  lineQ: number,
  phase: "opening" | "closing",
  extract: (prices: P) => LinePrices,
  pickFirst: boolean,
  market: QuarterLineMarket,
): PhaseOdds | null {
  const phaseAt = (prices: P, q: number) => {
    const { pair, maxBet } = extract(prices);
    return twoWayPhase(pair, pickFirst, maxBet, q);
  };
  const direct = byQuarter.get(lineQ)?.[phase];
  if (direct) return phaseAt(direct, lineQ);
  // Quarter line ausente → combina os componentes (±1 quarto). O snapshot é a
  // fonte da conta, para o preço gravado ser exatamente o recalculável.
  if (Math.abs(lineQ % 2) !== 1) return null;
  const lo = byQuarter.get(lineQ - 1)?.[phase];
  const hi = byQuarter.get(lineQ + 1)?.[phase];
  const a = lo ? phaseAt(lo, lineQ - 1) : null;
  const b = hi ? phaseAt(hi, lineQ + 1) : null;
  if (!a || !b) return null;
  const snapshot = quarterPriceSnapshot(market, [a.snapshot.components[0]!, b.snapshot.components[0]!]);
  const combined = recomputePriceSnapshot(snapshot);
  if (!combined) return null;
  return {
    ...combined,
    // A cotação sintética reproduz o preço, mas não o limite da linha ausente.
    maxBet: null,
    snapshot,
  };
}

/** Abertura e fechamento de uma linha 2-way (total ou handicap). */
function lineOdds<P extends { max_bet?: number }>(
  lines: Array<BridgeLine<P>> | undefined,
  lineQ: number,
  pair: (prices: P) => [number, number],
  pickFirst: boolean,
  market: QuarterLineMarket,
): ResolveOddsResult {
  const byQ = linesByQuarter(lines);
  const extract = (prices: P) => ({ pair: pair(prices), maxBet: prices.max_bet ?? null });
  const opening = resolveLinePhase(byQ, lineQ, "opening", extract, pickFirst, market);
  const current = resolveLinePhase(byQ, lineQ, "closing", extract, pickFirst, market);
  if (!opening && !current) {
    return { ok: false, reason: byQ.size === 0 ? "no_prices" : "line_mismatch" };
  }
  return { ok: true, odds: { opening, current } };
}

export function resolveBridgeOddsForBet(
  match: BridgeMatch,
  rawBet: { mercado: string; selecao: string },
  opts?: { observedAt?: Date; now?: Date },
): ResolveOddsResult {
  // Preço observado há mais de 15min não é preço atual: stale_price deixa o
  // chamador decidir no_prices/fallback em vez de contaminar o CLV.
  if (opts?.observedAt) {
    const nowMs = (opts.now ?? new Date()).getTime();
    const observedMs = opts.observedAt.getTime();
    if (
      Number.isFinite(nowMs) &&
      Number.isFinite(observedMs) &&
      nowMs - observedMs > BRIDGEODDS_CURRENT_PRICE_MAX_AGE_MS
    ) {
      return { ok: false, reason: "stale_price" };
    }
  }
  const evento = `${match.home} vs ${match.away}`;
  // A equivalência DNB/DC só troca a mecânica quotável. Um qualificador de
  // estatística no texto original continua tornando a aposta incompatível com
  // as linhas game-line do Bridge.
  if (!bridgeOddsSupportsScope(match.sport, rawBet.mercado, rawBet.selecao) ||
    isStatQualifierMarket(rawBet.mercado, rawBet.selecao) ||
    marketPeriodOf(rawBet.selecao) !== "FT" || hasScoreUnitMismatch(rawBet.mercado, rawBet.selecao, match.sport)) {
    return { ok: false, reason: "unsupported_market" };
  }
  // Equivalência sharp: DnB → AH 0.0, DC 1X/X2 → AH +0.5 (mesma resolução).
  const bet = effectiveSharpBet({ ...rawBet, evento });
  // Linha SEM o nome do time: dígito no clube ("Schalke 04", "1. FC Köln") não
  // pode virar linha em parseLineQuarters (mesma regra do settlement).
  const lineText = stripTeamNames(bet.selecao, evento);

  // Bridge só tem game-line FT (gols/pontos). Estatísticas (corners/cards)
  // e períodos parciais NUNCA podem ser precificados com estes números.
  if (isStatQualifierMarket(bet.mercado, bet.selecao)) {
    return { ok: false, reason: "unsupported_market" };
  }
  if (marketPeriodOf(bet.mercado) !== "FT") return { ok: false, reason: "unsupported_market" };

  const kind = marketKindOf(bet.mercado, bet.selecao, evento);
  if (kind === "moneyline") {
    const pick = matchMoneylineSelection(bet.selecao, evento);
    if (!pick) return { ok: false, reason: "ambiguous_selection" };
    const requireDraw = match.sport === BRIDGEODDS_COVERAGE.soccer.providerSport;
    const opening = moneylinePhase(match.moneyline?.opening, pick, requireDraw);
    const current = moneylinePhase(match.moneyline?.closing, pick, requireDraw);
    if (!opening && !current) return { ok: false, reason: "no_prices" };
    return { ok: true, odds: { opening, current } };
  }

  if (kind === "total") {
    const lineQ = parseLineQuarters(lineText, { allowNegative: false });
    if (lineQ === null) return { ok: false, reason: "missing_line" };
    const direction = totalDirectionOf(bet.selecao, { allowBarePositiveLine: true });
    if (!direction) return { ok: false, reason: "ambiguous_selection" };

    return lineOdds(match.total, lineQ, (p: BridgeTotalPrices) => [p.over, p.under], direction === "over", "total");
  }

  if (kind === "spread") {
    const lineQ = parseLineQuarters(lineText, { allowNegative: true });
    if (lineQ === null) return { ok: false, reason: "missing_line" };
    // Mesma regra do settlement: o lado vem do rótulo do mercado OU do nome na
    // seleção ("Home Asian Handicap" com a linha nua), e contradição entre os
    // dois não se resolve escolhendo um.
    const side = resolveSideFromMarketAndSelection(bet.mercado, bet.selecao, evento).side;
    if (!side) return { ok: false, reason: "ambiguous_selection" };
    // hdp_points é relativo ao HOME: aposta no away com linha L ↔ home -L.
    const homeLineQ = side === "home" ? lineQ : -lineQ;

    return lineOdds(match.spread, homeLineQ, (p: BridgeTwoWayPrices) => [p.home, p.away], side === "home", "spread");
  }

  return { ok: false, reason: "unsupported_market" };
}
