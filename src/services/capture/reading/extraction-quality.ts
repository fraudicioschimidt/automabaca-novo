import { llmBetSchema, type LlmBet, type LlmBetItem } from "./extraction-contract";
import { parseStoredLegs, type BetLegsTicket } from "@/src/domain/bet-legs";
import { keepDeclaredPeriod } from "@/src/domain/mercados/finalize";
import { captionDeclaresPromotionFunding, captionDeclaresTradingOperation, hasUnsupportedPromotionTerms, hasUnsupportedTradingTerms, MAX_ODDS, MAX_STAKE_UNIDADES } from "@/src/domain/bet-capture";
import { resolveCaptureStake, type CaptureStakeSettings } from "@/src/domain/capture-stake-policy";
import { mentionsLiveEntry, extractLiveScoresAtTip, resolveLiveScoreAtTip, stripKickoffFromSelection, stripLiveScoreAtTip } from "@/src/domain/live-score-at-tip";
import { asianHandicapLineNeedsRetry, asianHandicapSideNeedsRetry } from "@/src/domain/asian-handicap-line";
import { marketIncludesExtraTime, marketKindOf, marketPeriodOf } from "@/src/domain/mercados/classify";
import { matchTeamSide } from "@/src/domain/settlement/sides";
import { fixtureHasPlaceholderTeam, normalizeStr, splitEventoTeams } from "@/src/domain/text";

/** An explicit at-tip literal belongs to this extraction, not to the root of
 * another fixture. A bare parenthesized literal is joined to its own selection
 * for the existing paired/conflict validator; the numbers are never inferred. */
export function extractionScoreTexts(row: LlmBetItem): Array<string | undefined> {
  const evidence = row.liveScoreEvidence;
  return [row.selecao, evidence && /^\(\s*\d+\s*[-–—:x×]\s*\d+\s*\)$/.test(evidence)
    && row.selecao ? `${evidence} ${row.selecao}` : evidence];
}

/** Financial values are always per item. A score, a date or a sport reading
 * from the first fixture cannot leak into another fixture merely because it
 * occupies the root of the JSON: an item without its own sport had no
 * evidence for it, and the root's emoji may belong to another game. */
export function extractionRows(data: LlmBet): LlmBetItem[] {
  if (!data.items?.length) return [data];
  return data.items.map((item) => {
    const sameFixture = Boolean(data.evento && normalizeStr(item.evento || data.evento) === normalizeStr(data.evento));
    return { ...data, ...item,
      evento: item.evento || data.evento,
      esporte: item.esporte || (sameFixture ? data.esporte : undefined),
      sportConfidence: item.sportConfidence ?? (sameFixture ? data.sportConfidence : undefined),
      sportEvidenceText: item.sportEvidenceText || (sameFixture ? data.sportEvidenceText : undefined),
      competicao: item.competicao || data.competicao,
      mercado: item.mercado || data.mercado,
      selecao: item.selecao || (data.items?.length === 1 ? data.selecao : undefined),
      dataTexto: item.dataTexto || (sameFixture ? data.dataTexto : undefined),
      casaDeAposta: item.casaDeAposta || data.casaDeAposta,
      liveScoreHome: item.liveScoreHome ?? (sameFixture ? data.liveScoreHome : undefined),
      liveScoreAway: item.liveScoreAway ?? (sameFixture ? data.liveScoreAway : undefined),
      liveScoreEvidence: item.liveScoreEvidence || (sameFixture ? data.liveScoreEvidence : undefined),
      odds: item.odds, stake: item.stake, playerProp: item.playerProp,
    };
  });
}

/** Folga do produto das odds das pernas contra a odd total (arredondamento da casa). */
const COMBINED_ODDS_TOLERANCE = 0.02;

/**
 * Bilhete combinado (dupla, "Criar Aposta", acumulada): UMA odd e UMA stake
 * para várias pernas. O leitor declara (`accumulator`) ou a própria odd prova:
 * a total é o produto das odds das pernas. Stake própria por perna é a marca
 * de simples e vale mais que o rótulo.
 */
export function isCombinedTicket(data: LlmBet): boolean {
  const items = data.items ?? [];
  if (items.length < 2 || items.some((item) => item.stake !== undefined && item.stake > 0)) return false;
  if (data.ticketType === "accumulator") return true;
  if (data.ticketType === "singles" || data.odds === undefined) return false;
  const legOdds = items.map((item) => item.odds);
  if (!legOdds.every((odds): odds is number => odds !== undefined && odds > 1)) return false;
  const product = legOdds.reduce((total, odds) => total * odds, 1);
  return Math.abs(product - data.odds) / data.odds <= COMBINED_ODDS_TOLERANCE;
}

/** Pernas explícitas preservam seus mercados; o período global completa o que não foi declarado. */
export function combinedTicketLegs(data: LlmBet): BetLegsTicket | null {
  const legs = (data.items ?? []).map((item) => ({
    evento: (item.evento || data.evento || "").trim(),
    mercado: (item.mercado || "").trim(),
    selecao: (item.selecao || "").trim(),
  }));
  const fixtures = new Set(legs.map((leg) => normalizeStr(leg.evento)));
  const ticket = parseStoredLegs({ kind: fixtures.size > 1 ? "parlay" : "same_game", legs });
  return ticket ? { ...ticket, legs: ticket.legs.map((leg) => {
    if (marketPeriodOf(leg.mercado) !== "FT" || marketPeriodOf(leg.selecao) !== "FT") return leg;
    let mercado = keepDeclaredPeriod(data.mercado ?? "", leg.mercado);
    if (marketIncludesExtraTime(data.mercado ?? "") && !marketIncludesExtraTime(mercado)) {
      mercado = `${mercado} incluindo prorrogação`;
    }
    return { ...leg, mercado };
  }) } : null;
}

/**
 * Várias seleções com a MESMA odd, sem stake própria e sem o leitor dizer se é
 * múltipla ou simples: pode ser a odd total repetida em cada perna. Gravar
 * como simples multiplicaria o risco com a odd do bilhete inteiro.
 */
function isAmbiguousTicket(data: LlmBet): boolean {
  const items = data.items ?? [];
  if (items.length < 2 || data.ticketType === "singles" || data.ticketType === "accumulator") return false;
  if (items.some((item) => item.stake !== undefined && item.stake > 0)) return false;
  const first = items[0]?.odds;
  return first !== undefined && items.every((item) => item.odds === first);
}

export function missingExtractionNumbers(data: LlmBet, settings?: CaptureStakeSettings): string[] {
  // No combinado, odd e stake são do bilhete: as pernas não têm as suas.
  const rows = isCombinedTicket(data) ? [data] : extractionRows(data), missing: string[] = [];
  if (rows.some((row) => row.odds === undefined || !Number.isFinite(row.odds) || row.odds <= 1 || row.odds > MAX_ODDS)) missing.push("odds");
  if (rows.some((row) => {
    const { stake } = resolveCaptureStake(row.stake, settings, { zeroIsMissing: true });
    return stake === null || !Number.isFinite(stake) || stake <= 0 || stake > MAX_STAKE_UNIDADES;
  })) missing.push("stake");
  return missing;
}

export type FinancialProblem = "unsupported_trading_terms" | "unsupported_promotion_terms";

const FINANCIAL_EVIDENCE = {
  unsupported_trading_terms: { field: "operationEvidence", isTerm: hasUnsupportedTradingTerms },
  unsupported_promotion_terms: { field: "promotionEvidence", isTerm: hasUnsupportedPromotionTerms },
} as const;

const evidenceKey = (text: string) => normalizeStr(text).replace(/[^a-z0-9]+/g, " ").trim();

/**
 * O trecho que o leitor aponta como prova só vale quando é mesmo um termo sem
 * contrato ("Nenhuma", "N/A" e "Odd turbinada" não são) e, na fonte que é só
 * texto (`sourceText`), quando está escrito nela. Da imagem não há
 * transcrição para conferir: ali basta ser o termo.
 */
export function provenFinancialEvidence(row: LlmBetItem, problem: FinancialProblem, sourceText?: string): string | undefined {
  const { field, isTerm } = FINANCIAL_EVIDENCE[problem];
  const quoted = row[field]?.trim();
  if (!quoted || !isTerm(quoted)) return undefined;
  return sourceText === undefined || evidenceKey(sourceText).includes(evidenceKey(quoted)) ? quoted : undefined;
}

/** Termo financeiro sem contrato na linha lida: no mercado, na seleção ou na prova do leitor. */
export function rowFinancialProblem(row: LlmBetItem, sourceText?: string): FinancialProblem | null {
  if (hasUnsupportedTradingTerms(row.mercado, row.selecao) || provenFinancialEvidence(row, "unsupported_trading_terms", sourceText)) return "unsupported_trading_terms";
  if (hasUnsupportedPromotionTerms(row.mercado, row.selecao) || provenFinancialEvidence(row, "unsupported_promotion_terms", sourceText)) return "unsupported_promotion_terms";
  return null;
}

/** `evidenceSource`: o texto integral da fonte, quando ela não tem imagem. */
export function extractionContentProblem(data: LlmBet, caption?: string, evidenceSource?: string): string | null {
  if (!data.isBet) return data.items?.length || (data.visibleBetCount ?? 0) > 0 ? "non_bet_with_selections" : null;
  const financial = [data, ...(data.items ?? [])].map((row) => rowFinancialProblem(row, evidenceSource));
  if (financial.includes("unsupported_trading_terms") || captionDeclaresTradingOperation(caption)) return "unsupported_trading_terms";
  if (financial.includes("unsupported_promotion_terms") || captionDeclaresPromotionFunding(caption)) return "unsupported_promotion_terms";
  if (data.review) return data.review.reason;
  const rows = extractionRows(data);
  // Num bilhete combinado (Criar Aposta / SGP / acumulada), `items` são PERNAS
  // de UMA aposta. O leitor ora conta o bilhete (1), ora as pernas; as duas
  // leituras são honestas. A contagem por pernas continua pegando perna
  // faltando; o 1 do bilhete também é aceito.
  const combinado = isCombinedTicket(data);
  if (combinado && !combinedTicketLegs(data)) return "incomplete_extraction";
  if (!combinado && isAmbiguousTicket(data)) return "ambiguous_ticket";
  if (data.visibleBetCount !== undefined && data.visibleBetCount !== rows.length
    && !(combinado && data.visibleBetCount === 1)) return "incomplete_bet_list";
  if (data.ticketType === "singles" && rows.length < 2) return "incomplete_bet_list";
  if (caption) {
    const count = caption.match(/\b(\d{1,2})\s+(?:apostas\s+)?simples\b/i)?.[1];
    if (count && Number(count) !== rows.length) return "incomplete_bet_list";
    const stakes = caption.split(/\r?\n/).filter((line) => /^\s*(?:(?:stake|entrada)\s*[:=-]?\s*)?\d+(?:[.,]\d+)?\s*(?:u|unidades?)(?:\s*@\s*\d+(?:[.,]\d+)?)?\s*$/i.test(line));
    // Multiple explicit units describe ordered singles. One shared unit only
    // distributes when the source actually says 'cada'; no phantom rows.
    if (stakes.length > 1 && stakes.length !== rows.length && !combinado) return "incomplete_bet_list";
  }
  for (const row of rows) {
    if (!row.evento || !row.mercado || !row.selecao) return "incomplete_extraction";
    if (!splitEventoTeams(row.evento) || fixtureHasPlaceholderTeam(row.evento)) return "incomplete_fixture";
    const kind = marketKindOf(row.mercado, row.selecao, row.evento);
    if (kind === "team_total" && !matchTeamSide(row.selecao, row.evento)) return "missing_selected_team";
    // O horário que a IA copiou para a seleção sai no guard; aqui esconderia a linha.
    const selection = stripLiveScoreAtTip(stripKickoffFromSelection(row.selecao), row.mercado);
    if (kind === "spread" && (asianHandicapLineNeedsRetry(selection, row.evento)
      || asianHandicapSideNeedsRetry(selection, row.evento, row.mercado))) return "incomplete_handicap_terms";
    if (/\b(?:final|full.?time|resultado|encerrado)\b/i.test(row.liveScoreEvidence ?? "")) return "live_score_not_at_tip";
    const live = resolveLiveScoreAtTip({ liveScoreHome: row.liveScoreHome, liveScoreAway: row.liveScoreAway,
      texts: extractionScoreTexts(row), market: row.mercado });
    if (!live.ok) return live.reason;
    const scoreTexts = [...extractionScoreTexts(row), ...(rows.length === 1 ? [caption] : [])];
    if (live.score && !scoreTexts.some((text) => text && extractLiveScoresAtTip(text, { market: row.mercado }).length)) return "unproven_live_score";
  }
  if (combinado) {
    const liveRows = [data, ...rows];
    const hasLive = liveRows.some((row) => row.liveScoreHome != null || row.liveScoreAway != null
      || [...extractionScoreTexts(row), row.mercado].some((text) => text && (mentionsLiveEntry(text)
        || extractLiveScoresAtTip(text, { market: row.mercado }).length > 0)));
    if (hasLive) {
      const root = resolveLiveScoreAtTip({ liveScoreHome: data.liveScoreHome, liveScoreAway: data.liveScoreAway,
        texts: extractionScoreTexts(data), market: data.mercado });
      const fixtures = new Set(rows.map((row) => normalizeStr(row.evento ?? "")));
      // Só o criar-aposta de UM jogo tem um placar estruturado representável.
      if (fixtures.size !== 1 || !root.ok || !root.score) return "incomplete_live_score";
      for (const row of rows) {
        const live = resolveLiveScoreAtTip({ liveScoreHome: row.liveScoreHome, liveScoreAway: row.liveScoreAway,
          texts: extractionScoreTexts(row), market: row.mercado });
        if (live.ok && live.score && (live.score.home !== root.score.home || live.score.away !== root.score.away)) {
          return "conflicting_live_score";
        }
      }
    }
  }
  // An unambiguous live prefix in a single-pick caption is independent of the
  // model output. Missing scores can be recovered; conflicting ones cannot.
  if (caption && rows.length === 1 && rows[0]) {
    const row = rows[0];
    const live = resolveLiveScoreAtTip({ liveScoreHome: row.liveScoreHome, liveScoreAway: row.liveScoreAway,
      texts: [...extractionScoreTexts(row), caption], market: row.mercado });
    if (!live.ok) return live.reason;
    if (extractLiveScoresAtTip(caption, { market: row.mercado }).length && !live.score) return "incomplete_live_score";
  }
  return null;
}

export function extractionState(raw: unknown, settings?: CaptureStakeSettings): "invalid" | "not_bet" | "review" | "draft" | "complete" {
  const parsed = llmBetSchema.safeParse(raw);
  if (!parsed.success) return "invalid";
  if (extractionContentProblem(parsed.data)) return "review";
  if (!parsed.data.isBet) return "not_bet";
  return missingExtractionNumbers(parsed.data, settings).length ? "draft" : "complete";
}
