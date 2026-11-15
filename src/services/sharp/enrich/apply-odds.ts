import type { NoOddsReason } from "@/src/domain/no-odds-reason";
import { splitEventoTeams } from "@/src/domain/text";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { createLogger } from "@/src/infra/logger";
import type { BridgeMatch } from "@/src/providers/bridgeodds/types";
import { resolveBridgeOddsForBet } from "@/src/providers/bridgeodds/odds";
import { bridgeOddsIsAuthoritative, marketHasNoSharpReference } from "@/src/providers/coverage";
import { isSegmentSharpOff } from "@/src/services/sharp/segment-policy";
import { tryClosingReferenceFallback } from "./pinnacle17-identity";
import { upsertSharp, type UpsertSharpFn } from "./upsert-sharp";

const log = createLogger("sharp-enrich");

/** Motivo da ausência de preço de entrada: depende só do modo sharp da banca. */
function idleNoOddsReason(sharpMode: string): NoOddsReason {
  if (sharpMode === "IDENTITY_ONLY") return "identity_only";
  if (sharpMode === "CLV_ONLY") return "clv_only";
  return "sharp_off";
}

function measuresClv(sharpMode: string): boolean {
  return sharpMode === "CLV_ONLY";
}

export type ApplyOddsBet = {
  id: string;
  mercado: string;
  selecao: string;
  data: Date;
  registradoEm: Date;
  sourcePostedAt?: Date | null;
  bankroll: { sharpMode: string };
};

/**
 * Grava a identidade casada na BridgeOdds. Sem preço de entrada: o CLV sai do
 * fechamento, que usa o `providerMatchId` gravado aqui. Quando a Bridge não
 * precifica o mercado ou a linha, a referência de fechamento vem da
 * Pinnacle17 — sem ela a aposta ficaria sem CLV. Se a Pinnacle17 ainda não tem
 * a linha, fica o motivo dela, e o enrich tenta de novo até o kickoff
 * (`retryClosingReference`).
 */
export async function applyBridgeOdds(params: {
  bet: ApplyOddsBet;
  match: BridgeMatch;
  esporteCanonico: string;
  competicao: string;
  pais: string;
  confidence: number;
  kickoffValido: boolean;
  kickoff: Date;
  priceObservedAt: Date;
  /** Resultado já calculado pelo orquestrador para não repetir a leitura. */
  segmentOff?: boolean;
  upsert?: UpsertSharpFn;
}): Promise<void> {
  const { bet, match, esporteCanonico, confidence } = params;
  const upsert = params.upsert ?? upsertSharp;
  const segmentOff = params.segmentOff ?? await isSegmentSharpOff(esporteCanonico, bet.mercado);
  const semReferenciaSharp = marketHasNoSharpReference({ esporte: esporteCanonico, mercado: bet.mercado });
  let waitingReason: NoOddsReason | null = null;

  if (measuresClv(bet.bankroll.sharpMode) && !segmentOff && !semReferenciaSharp) {
    // Só a disponibilidade do mercado/linha importa aqui, não o frescor do preço.
    const bridge = resolveBridgeOddsForBet(
      match,
      { mercado: bet.mercado, selecao: bet.selecao },
      { observedAt: params.priceObservedAt, now: params.priceObservedAt },
    );
    if (!bridge.ok && (bridge.reason === "unsupported_market" || bridge.reason === "line_mismatch")) {
      const kickoffUtc = params.kickoffValido ? params.kickoff : bet.data;
      const fallback = await tryClosingReferenceFallback({
        betId: bet.id,
        matchId: match.match_id,
        home: match.home,
        away: match.away,
        esporte: esporteCanonico,
        competicao: params.competicao,
        pais: params.pais,
        mercado: bet.mercado,
        selecao: bet.selecao,
        kickoffUtc,
        registradoEm: bet.registradoEm,
        sourcePostedAt: bet.sourcePostedAt,
        confidence,
        upsertSharp: upsert,
      });
      if (fallback.done) return;
      // Depois do kickoff ninguém tenta de novo: fica o motivo do modo.
      if (kickoffUtc.getTime() > Date.now()) waitingReason = fallback.reason;
    }
  }

  await upsert(bet.id, {
    identityStatus: "MATCHED",
    confidence,
    provider: "bridgeodds",
    providerMatchId: String(match.match_id),
    priceReference: null,
    noOddsReason: semReferenciaSharp
      ? "sem_referencia_sharp"
      : segmentOff
        ? "sharp_off"
        : waitingReason ?? idleNoOddsReason(bet.bankroll.sharpMode),
  });
  if (semReferenciaSharp) {
    log.info(
      { eventCode: LOG_EVENTS.SHARP_PRICE_UNAVAILABLE, reasonCode: "no_reference", betId: bet.id, esporte: esporteCanonico, mercado: bet.mercado },
      "mercado sem referência sharp — identidade gravada, odds não se aplicam",
    );
  }
}

/**
 * Aposta já casada pela Bridge (pelo casamento automático ou pelo Vincular) e
 * ainda sem referência de fechamento: tenta a da Pinnacle17 de novo, pelo id do
 * jogo, enquanto a Bridge não precifica o mercado (fora da matriz dela) ou a
 * tentativa anterior deixou um motivo que ainda pode mudar. O motivo gravado
 * diz se há próxima tentativa: o permanente encerra (`classifyEnrichSkip`).
 */
export async function retryClosingReference(bet: ApplyOddsBet & {
  evento: string;
  esporte: string;
  competicao: string;
  pais: string;
  sharp: { providerMatchId: string; confidence: number; noOddsReason: string | null };
}, now: Date): Promise<void> {
  const coverage = { esporte: bet.esporte, mercado: bet.mercado, selecao: bet.selecao };
  const semReferenciaSharp = marketHasNoSharpReference(coverage);
  const segmentOff = await isSegmentSharpOff(bet.esporte, bet.mercado);
  const teams = splitEventoTeams(bet.evento);
  let waitingReason: NoOddsReason | null = null;
  if (measuresClv(bet.bankroll.sharpMode) && !segmentOff && !semReferenciaSharp && teams && bet.data.getTime() > now.getTime()
    && (bet.sharp.noOddsReason !== null || !bridgeOddsIsAuthoritative(coverage))) {
    const fallback = await tryClosingReferenceFallback({
      betId: bet.id,
      matchId: Number(bet.sharp.providerMatchId),
      home: teams.home,
      away: teams.away,
      esporte: bet.esporte,
      competicao: bet.competicao,
      pais: bet.pais,
      mercado: bet.mercado,
      selecao: bet.selecao,
      kickoffUtc: bet.data,
      registradoEm: bet.registradoEm,
      sourcePostedAt: bet.sourcePostedAt,
      confidence: bet.sharp.confidence,
      upsertSharp,
    });
    if (fallback.done) return;
    waitingReason = fallback.reason;
  }
  await upsertSharp(bet.id, {
    identityStatus: "MATCHED",
    confidence: bet.sharp.confidence,
    noOddsReason: semReferenciaSharp
      ? "sem_referencia_sharp"
      : segmentOff
        ? "sharp_off"
        : waitingReason ?? idleNoOddsReason(bet.bankroll.sharpMode),
  });
}
