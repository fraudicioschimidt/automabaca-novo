import { MAX_ODDS, MAX_STAKE_UNIDADES, type ParsedBetPost } from "@/src/domain/bet-capture";
import type { CaptureOcrEvidence, OcrReading } from "@/src/domain/capture-ocr-evidence";
import { resolveCaptureStake, type CaptureStakeSettings } from "@/src/domain/capture-stake-policy";
import { parseBrKickoffDetailed } from "@/src/domain/dates";
import { parseDecimalInput } from "@/src/domain/decimal-input";
import { resolveLiveScoreAtTip } from "@/src/domain/live-score-at-tip";
import { tokensDaSelecao } from "@/src/domain/settlement/goalscorer-matching";
import { llmSportDecision, UNKNOWN_SPORT } from "@/src/domain/sports/detect";
import { createLogger } from "@/src/infra/logger";
import { llmBetSchema } from "./extraction-contract";
import { combinedTicketLegs, extractionContentProblem, extractionRows, extractionScoreTexts, isCombinedTicket, rowFinancialProblem } from "./extraction-quality";

/* Converte a resposta do LLM (input hostil, já validado pelo schema) em apostas
 * e na proveniência da leitura. */

const log = createLogger("llm-extract-map");

export function isUsableBetExtraction(raw: unknown): boolean {
  const parsed = llmBetSchema.safeParse(raw);
  if (!parsed.success) return false;
  const data = parsed.data;
  if (!data.isBet) return true;
  if (data.review) return true;
  if (data.items?.length) return data.items.every((item) => {
    const selection = item.selecao || data.selecao;
    return Boolean((item.evento || data.evento) && selection && (item.mercado || data.mercado)) && resolveLiveScoreAtTip({ liveScoreHome: item.liveScoreHome, liveScoreAway: item.liveScoreAway, texts: extractionScoreTexts(item), market: item.mercado }).ok;
  });
  if (!data.evento || !data.selecao || !data.mercado) return false;
  const liveScore = resolveLiveScoreAtTip({
    liveScoreHome: data.liveScoreHome,
    liveScoreAway: data.liveScoreAway,
    texts: extractionScoreTexts(data), market: data.mercado,
  });
  return liveScore.ok;
}

/** `withoutOdds`: a leitura segue sem a odd (0), para o guard recusar e perguntá-la ao dono. */
type MapOptions = {
  withoutOdds?: boolean;
  /** Texto integral da fonte sem imagem: a prova financeira do leitor precisa estar nele. */
  evidenceSource?: string;
};

/**
 * Valida e converte o JSON do LLM para ParsedBetPost.
 * Null = não é aposta ou faltou campo essencial (caller alerta).
 */
export function mapLlmBetToParsed(raw: unknown, now: Date, stakeSettings?: CaptureStakeSettings, options: MapOptions = {}): ParsedBetPost | null {
  const parsed = llmBetSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn({ issues: parsed.error.issues }, "JSON do LLM fora do schema");
    return null;
  }
  const read = parsed.data;
  const data = options.withoutOdds && (read.odds === undefined || read.odds <= 1) ? { ...read, odds: 0 } : read;
  if (!data.isBet || rowFinancialProblem(data, options.evidenceSource)) return null;
  const resolvedStake = resolveCaptureStake(data.stake, stakeSettings, { zeroIsMissing: true });
  const stake = resolvedStake.stake;
  if (
    !data.evento || !data.selecao || !data.mercado?.trim() ||
    data.odds === undefined || stake === null
  ) {
    return null;
  }
  if (!(options.withoutOdds && data.odds === 0) && (!Number.isFinite(data.odds) || data.odds <= 1 || data.odds > MAX_ODDS)) {
    log.warn(
      { odds: data.odds, maxOdds: MAX_ODDS },
      "odd do LLM fora do intervalo plausível — descartado",
    );
    return null;
  }

  if (!Number.isFinite(stake) || stake <= 0 || stake > MAX_STAKE_UNIDADES) {
    log.warn(
      { stakeOriginal: data.stake, maxStake: MAX_STAKE_UNIDADES },
      "stake do LLM ausente ou fora do intervalo plausível — descartada",
    );
    return null;
  }

  const liveScore = resolveLiveScoreAtTip({
    liveScoreHome: data.liveScoreHome,
    liveScoreAway: data.liveScoreAway,
    texts: extractionScoreTexts(data), market: data.mercado,
  });
  if (!liveScore.ok) {
    log.warn({ reason: liveScore.reason }, "placar live do LLM inconsistente — descartado");
    return null;
  }

  const kickoff = data.dataTexto ? parseBrKickoffDetailed(data.dataTexto, now) : null;
  const sportResolution = llmSportDecision({
    sport: data.esporte,
    confidence: data.sportConfidence,
    evidenceText: data.sportEvidenceText,
  });

  return {
    playerProp: data.playerProp,
    stakeSource: data.stakeSource,
    evento: data.evento,
    esporte: sportResolution.sport ?? UNKNOWN_SPORT,
    competicao: data.competicao ?? "",
    pais: "",
    mercado: data.mercado.trim(),
    selecao: data.playerProp && tokensDaSelecao(data.selecao).length === 0 ? `${data.playerProp.jogador} ${data.selecao}` : data.selecao,
    ...(liveScore.score
      ? {
          liveScoreHome: liveScore.score.home,
          liveScoreAway: liveScore.score.away,
          ...(data.liveScoreEvidence ? { liveScoreEvidence: extractionScoreTexts(data)[1] } : {}),
        }
      : {}),
    odds: data.odds,
    stake,
    ...(resolvedStake.snapshot ? { stakePolicySnapshot: resolvedStake.snapshot } : {}),
    data: kickoff?.date ?? null,
    kickoffDateOnly: kickoff?.dateOnly,
    casaDeAposta: data.casaDeAposta ?? "",
    sportResolution,
  };
}

export function mapLlmBetToParsedList(raw: unknown, now: Date, stakeSettings?: CaptureStakeSettings, options: MapOptions = {}): ParsedBetPost[] | null {
  const parsed = llmBetSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.isBet) return null;
  const data = parsed.data;
  if ([data, ...(data.items ?? [])].some((row) => rowFinancialProblem(row, options.evidenceSource))) return null;

  if (isCombinedTicket(data)) {
    const legs = combinedTicketLegs(data);
    // Nunca converter uma leitura incompleta de múltipla em simples na raiz.
    if (!legs || extractionContentProblem(data, undefined, options.evidenceSource)) return null;
    const single = mapLlmBetToParsed({ ...data, items: undefined }, now, stakeSettings, options);
    return single ? [{ ...single, legs }] : null;
  }

  if (Array.isArray(data.items) && data.items.length > 0) {
    const list: ParsedBetPost[] = [];
    for (const item of extractionRows(data)) {
      const merged = { ...item, isBet: true };
      const single = mapLlmBetToParsed(merged, now, stakeSettings, options);
      if (!single) return null;
      list.push(single);
    }
    if (list.length > 0) return list;
  }

  const single = mapLlmBetToParsed(data, now, stakeSettings, options);
  return single ? [single] : null;
}

/* Proveniência da leitura (OCR evidence) gravada junto das apostas. */

/** Retain declared source fields before coercion, including null and decimals.
 * Unknown model fields can never become server-owned provenance. */
export function extractionSourceFields(raw: unknown): Record<string, unknown> | undefined {
  const parsed = llmBetSchema.safeParse(raw);
  if (!parsed.success || !raw || typeof raw !== "object") return undefined;
  const pick = (original: Record<string, unknown>, shape: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.keys(shape).filter((key) => key in original).map((key) => {
      const value = original[key], declared = shape[key];
      return [key, Array.isArray(value) && Array.isArray(declared)
        ? value.map((item, i) => item && typeof item === "object" && declared[i] && typeof declared[i] === "object"
          ? pick(item, declared[i]) : item)
        : value && typeof value === "object" && declared && typeof declared === "object"
          ? pick(value as Record<string, unknown>, declared as Record<string, unknown>) : value];
    }));
  return pick(raw as Record<string, unknown>, parsed.data);
}

export function extractionEvidence(reading: OcrReading | undefined, sourceFields: Record<string, unknown> | undefined,
  state: CaptureOcrEvidence["state"], bets?: ParsedBetPost[]): CaptureOcrEvidence | undefined {
  if (!reading || !sourceFields) return undefined;
  const rows = Array.isArray(sourceFields.items) && sourceFields.items.length
    ? sourceFields.items as Record<string, unknown>[] : [sourceFields];
  const transformations = new Set<string>();
  for (const [i, row] of rows.entries()) {
    if (typeof row.odds === "string" || typeof row.stake === "string") transformations.add("decimal_normalization");
    const bet = bets?.[i];
    if (!bet) continue;
    if (bet.data && row.dataTexto) transformations.add("source_date_parsing");
    if (bet.odds !== parseDecimalInput(row.odds)) transformations.add("caption_odds_policy");
    if (bet.stakePolicySnapshot?.source !== undefined && bet.stakePolicySnapshot.source !== "message") transformations.add(bet.stakePolicySnapshot.source);
    else if (bet.stake !== parseDecimalInput(row.stake)) transformations.add("caption_stake_assignment");
    if (bet.selecao !== row.selecao) transformations.add("selection_reconciliation");
    if (bet.liveScoreHome !== undefined || bet.liveScoreAway !== undefined) transformations.add("live_score_evidence");
    else if (row.liveScoreHome !== undefined && row.liveScoreHome !== null) transformations.add("unproven_live_score_removed");
  }
  return { version: 1, state, accuracy: "unreviewed", readers: [reading], sourceFields, transformations: [...transformations] };
}
