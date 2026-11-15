import { marketKindOf, marketPeriodOf } from "@/src/domain/mercados/classify";
import { sharpEquivalentBet } from "@/src/domain/mercados/sharp-equivalent";
import { totalDirectionOf } from "@/src/domain/mercados/total-direction";
import { autoFairProbs, powerFairOdds } from "@/src/domain/odds";
import { singlePriceSnapshot } from "@/src/domain/price-provenance";
import { lineToQuarters, parseLineQuarters } from "@/src/domain/settlement/lines";
import {
  matchMoneylineSelection,
  matchDoubleChanceSelection,
  resolveSideFromMarketAndSelection,
  stripTeamNames,
} from "@/src/domain/settlement/sides";
import { normalizeStr } from "@/src/domain/text";
import { isStatQualifierMarket } from "@/src/providers/coverage";
import type { SharpPhaseOdds } from "@/src/domain/sharp-price";
import { pinnacle17MarketContract, pinnacle17MarketMatchesContract, type Pinnacle17MarketContract } from "./market-contract";
import { pinnacle17SportId } from "./types";
import { PINNACLE17_CURRENT_PRICE_MAX_AGE_MS } from "./limits";
import type {
  Pinnacle17Event,
  Pinnacle17Market,
  Pinnacle17Outcome,
  Pinnacle17PriceReference,
} from "./types";

type Pinnacle17ResolvedOdds = {
  current: SharpPhaseOdds;
  reference: Pinnacle17PriceReference;
  /**
   * Horário do jogo para a Pinnacle. A resposta de odds não traz o evento, só
   * o corte de cada mercado, e só o do jogo inteiro (período 0) fecha no apito.
   * Null quando a resposta não traz mercado de período 0.
   */
  gameStartAt: Date | null;
};

type Pinnacle17ResolveResult =
  | { ok: true; value: Pinnacle17ResolvedOdds }
  | { ok: false; reason: "unsupported_market" | "ambiguous_selection" | "missing_line" | "line_mismatch" | "no_prices" | "market_not_listed" | "stale_price" };

type Candidate = {
  market: Pinnacle17Market;
  unit: string;
  selected: Pinnacle17Outcome;
  selectedIndex: number;
  book: Pinnacle17Outcome[];
  lineQ: number | null;
  outcomeToken: string;
};

function completeBook(market: Pinnacle17Market, designations: readonly Pinnacle17Outcome["designation"][]): Pinnacle17Outcome[] | null {
  if (market.outcomes.length !== designations.length || market.outcomes.some(row => !Number.isFinite(row.oddsDecimal) || row.oddsDecimal <= 1)) return null;
  const rows = designations.map(side => market.outcomes.filter(outcome => outcome.designation === side));
  return rows.every(row => row.length === 1) ? rows.map(row => row[0]!) : null;
}

function exactQuarter(line: number): number | null {
  return Number.isFinite(line) && Number.isSafeInteger(line * 4) ? lineToQuarters(line) : null;
}

/**
 * O corte dos mercados pré-jogo do jogo inteiro (período 0) na resposta: o
 * mercado de período da aposta não o informa, mas vem na mesma resposta dos
 * que informam. Com cortes diferentes, vale o mais tardio.
 */
function fullGameCutoff(markets: Pinnacle17Market[]): Date | null {
  const cutoffs = markets
    .filter((market) => market.period === 0 && market.isLive === false && market.special === null && market.cutoffAt !== null)
    .map((market) => new Date(market.cutoffAt!).getTime())
    .filter(Number.isFinite);
  return cutoffs.length ? new Date(Math.max(...cutoffs)) : null;
}

function maxRiskStake(market: Pinnacle17Market): number | null {
  const amount = market.limits.find((limit) => normalizeStr(limit.type) === "maxriskstake")?.amount;
  return typeof amount === "number" && amount >= 0 ? amount : null;
}

type CandidateParams = {
  event: Pinnacle17Event;
  markets: Pinnacle17Market[];
  esporte: string;
  mercado: string;
  selecao: string;
  observedAt: Date;
};

/** O que cada família precisa para escolher o livro: mercado já contratado e seleção limpa. */
type CandidateContext = {
  params: CandidateParams;
  evento: string;
  selection: string;
  contract: Pinnacle17MarketContract;
  rows: Pinnacle17Market[];
};

type CandidateOrReason = Candidate | Extract<Pinnacle17ResolveResult, { ok: false }>;

function moneylineCandidate({ params, evento, selection, contract, rows }: CandidateContext): CandidateOrReason {
  const pick = matchMoneylineSelection(selection, evento);
  if (!pick) return { ok: false, reason: "ambiguous_selection" };
  for (const market of rows.filter((row) => row.type === "moneyline")) {
    const hasDraw = pinnacle17SportId(params.esporte) === 29 || contract.scope === "regulation" || market.outcomes.some((outcome) => outcome.designation === "draw");
    const book = completeBook(market, hasDraw ? ["home", "draw", "away"] : ["home", "away"]);
    if (!book) continue;
    const selectedIndex = book.findIndex((outcome) => outcome.designation === pick);
    if (selectedIndex >= 0) return {
      market,
      unit: contract.unit,
      selected: book[selectedIndex]!,
      selectedIndex,
      book,
      lineQ: null,
      outcomeToken: pick,
    };
  }
  return { ok: false, reason: "no_prices" };
}

function totalCandidate(
  { params, evento, selection, contract, rows }: CandidateContext,
  kind: "total" | "team_total",
  lineQ: number,
): CandidateOrReason {
  const direction = totalDirectionOf(selection, { allowBarePositiveLine: true });
  if (!direction) return { ok: false, reason: "ambiguous_selection" };
  const side = kind === "team_total"
    ? resolveSideFromMarketAndSelection(params.mercado, selection, evento).side
    : null;
  if (kind === "team_total" && !side) return { ok: false, reason: "ambiguous_selection" };
  for (const market of rows.filter((row) => row.type === kind)) {
    if (kind === "team_total") {
      const team = normalizeStr(market.team ?? "");
      const expected = normalizeStr(side === "home" ? params.event.homeTeam.name : params.event.awayTeam.name);
      if (!team || team !== expected) continue;
    }
    const book = completeBook(market, ["over", "under"]);
    if (!book) continue;
    const marketLine = market.line ?? book[0]?.line ?? book[1]?.line;
    if (marketLine == null || exactQuarter(marketLine) !== lineQ ||
      book.some(row => row.line !== null && exactQuarter(row.line) !== lineQ)) continue;
    const selectedIndex = direction === "over" ? 0 : 1;
    return {
      market,
      unit: contract.unit,
      selected: book[selectedIndex]!,
      selectedIndex,
      book,
      lineQ,
      outcomeToken: side ? `${side}_${direction}` : direction,
    };
  }
  return { ok: false, reason: "line_mismatch" };
}

function spreadCandidate({ params, evento, selection, contract, rows }: CandidateContext, lineQ: number): CandidateOrReason {
  const side = resolveSideFromMarketAndSelection(params.mercado, selection, evento).side;
  if (!side) return { ok: false, reason: "ambiguous_selection" };
  for (const market of rows.filter((row) => row.type === "spread")) {
    const book = completeBook(market, ["home", "away"]);
    if (!book) continue;
    const selectedIndex = side === "home" ? 0 : 1;
    const selected = book[selectedIndex]!;
    const selectedLine = selected.line ?? (market.line === null ? null : side === "home" ? market.line : -market.line);
    if (selectedLine === null || exactQuarter(selectedLine) !== lineQ) continue;
    const homeLine = book[0]!.line ?? market.line ?? (book[1]!.line === null ? null : -book[1]!.line);
    const awayLine = book[1]!.line ?? (homeLine === null ? null : -homeLine);
    if (homeLine === null || awayLine === null || exactQuarter(homeLine) === null ||
      exactQuarter(awayLine) !== -exactQuarter(homeLine)! ||
      (market.line !== null && exactQuarter(market.line) !== exactQuarter(homeLine))) continue;
    return { market, unit: contract.unit, selected, selectedIndex, book, lineQ, outcomeToken: side };
  }
  return { ok: false, reason: "line_mismatch" };
}

function findCandidate(params: CandidateParams, contract: Pinnacle17MarketContract): CandidateOrReason {
  const evento = `${params.event.homeTeam.name} vs ${params.event.awayTeam.name}`;
  const kind = marketKindOf(params.mercado, params.selecao, evento);
  const rows = params.markets.filter(market => {
    const cutoff = market.cutoffAt === null ? null : new Date(market.cutoffAt).getTime();
    return market.isLive === false && /^open$/i.test(market.status) && market.special === null &&
      (cutoff === null || (Number.isFinite(cutoff) && cutoff > params.observedAt.getTime())) &&
      pinnacle17MarketMatchesContract(market, contract, params.esporte);
  });

  if (["moneyline", "spread", "total", "team_total"].includes(kind) && !rows.some((market) => market.type === kind)) {
    return { ok: false, reason: "market_not_listed" };
  }
  const context: CandidateContext = { params, evento, selection: contract.selection, contract, rows };
  if (kind === "moneyline") return moneylineCandidate(context);

  const lineText = stripTeamNames(context.selection, evento);
  const lineQ = parseLineQuarters(lineText, { allowNegative: kind === "spread" });
  if (lineQ === null) return { ok: false, reason: "missing_line" };
  if (kind === "total" || kind === "team_total") return totalCandidate(context, kind, lineQ);
  if (kind === "spread") return spreadCandidate(context, lineQ);
  return { ok: false, reason: "unsupported_market" };
}

export function resolvePinnacle17CurrentOdds(params: {
  event: Pinnacle17Event;
  markets: Pinnacle17Market[];
  esporte: string;
  mercado: string;
  selecao: string;
  observedAt: Date;
  now?: Date;
}): Pinnacle17ResolveResult {
  const now = params.now ?? new Date();
  const age = now.getTime() - params.observedAt.getTime();
  if (!Number.isFinite(age) || age < -1_000 || age > PINNACLE17_CURRENT_PRICE_MAX_AGE_MS) {
    return { ok: false, reason: "stale_price" };
  }
  if (params.event.sport.id !== pinnacle17SportId(params.esporte) ||
    params.event.status.isStarted !== false || params.event.status.isInProgress !== false || params.event.status.isInterrupted !== false ||
    !Number.isFinite(new Date(params.event.startTime).getTime()) || new Date(params.event.startTime).getTime() <= params.observedAt.getTime()) {
    return { ok: false, reason: "no_prices" };
  }
  const evento = `${params.event.homeTeam.name} vs ${params.event.awayTeam.name}`;
  const kind = marketKindOf(params.mercado, params.selecao, evento);
  const contract = pinnacle17MarketContract({ ...params, evento });
  if (!contract) return { ok: false, reason: "unsupported_market" };
  // A mesma equivalência serve à entrada e ao closing. Preservar período e
  // unidade: DC de escanteios nunca pode usar o handicap de gols.
  const equivalent = isStatQualifierMarket(params.mercado, params.selecao)
    ? null : sharpEquivalentBet({ ...params, evento });
  if (!equivalent && (kind === "double_chance" || kind === "draw_no_bet")) {
    if (isStatQualifierMarket(params.mercado, params.selecao) || marketPeriodOf(params.mercado) !== "FT" || marketPeriodOf(params.selecao) !== "FT") {
      return { ok: false, reason: "unsupported_market" };
    }
    return { ok: false, reason: kind === "double_chance" && matchDoubleChanceSelection(params.selecao, evento)
      ? "unsupported_market" : "ambiguous_selection" };
  }
  // Traduzir a mecânica não troca a unidade/período contratados na entrada.
  const candidate = findCandidate({ ...params, ...equivalent }, equivalent
    ? { ...contract, selection: equivalent.selecao } : contract);
  if ("ok" in candidate) return candidate;
  const rawOdds = candidate.book.map((outcome) => outcome.oddsDecimal);
  const fairOdds = rawOdds.length === 2
    ? powerFairOdds(rawOdds)
    : autoFairProbs(rawOdds)?.map((probability) => 1 / probability);
  const raw = rawOdds[candidate.selectedIndex];
  const fair = fairOdds?.[candidate.selectedIndex];
  if (raw === undefined || fair === undefined || !Number.isFinite(fair)) {
    return { ok: false, reason: "no_prices" };
  }
  const line = candidate.lineQ === null ? "ml" : String(candidate.lineQ);
  return {
    ok: true,
    value: {
      current: {
        raw,
        fair,
        maxBet: maxRiskStake(candidate.market),
        snapshot: singlePriceSnapshot({
          rawOdds,
          selectedIndex: candidate.selectedIndex,
          devig: rawOdds.length === 2 ? "power" : "auto",
          lineQ: candidate.lineQ,
          maxBet: maxRiskStake(candidate.market),
        }),
      },
      gameStartAt: fullGameCutoff(params.markets),
      reference: {
        provider: "pinnacle17",
        eventId: params.event.id,
        period: candidate.market.period,
        marketType: candidate.market.type,
        line,
        outcome: candidate.outcomeToken,
        unit: candidate.unit,
      },
    },
  };
}
