import { percentualContraFair } from "@/src/domain/odds";
import { entrouAoVivo } from "@/src/domain/entrada-ao-vivo";
import { toNumber } from "@/src/domain/money";
import { maxBetCurrencyForProvider } from "@/src/services/sharp/liquidity-currency";
import type { Prisma } from "@/src/generated/prisma/client";
import { sendOperatorNotification } from "@/src/services/ops/alerts";
import { createLogger } from "@/src/infra/logger";
import { type BridgeMatch, bridgeClosingIsFinal, encodeBridgePriceReference } from "@/src/providers/bridgeodds/types";
import { resolveBridgeOddsForBet } from "@/src/providers/bridgeodds/odds";
import { writeClosingOnce } from "@/src/services/sharp/closing-guard";
import type { ClosingSyncBet } from "./types";
import { assertPriceProvenance } from "@/src/domain/price-provenance";
import { linhaClv, linhaMovimento } from "@/src/domain/mensagem-operador";
import { saveBridgeOpening } from "@/src/services/sharp/bridge-postgame";
import { bridgeMatchGameStart } from "@/src/services/sharp/enrich/apply-identity";

const log = createLogger("closing");

/**
 * Linha de fechamento Bridge e CLV, uma vez por aposta.
 *
 * CLV = `percentualContraFair(oddCravada, closingFair)` — contra a fair
 * devigada. Não é “beat the close” vs raw Pinnacle.
 */
export async function processBridgeClv(
  bet: ClosingSyncBet,
  match: BridgeMatch,
  now: Date,
  opts: { priceObservedAt?: Date } = {},
): Promise<boolean> {
  if (bet.closing?.fetchedAt) return false;

  // Entrada ao vivo: o closing retroativo da BridgeOdds EXISTE (ela guarda
  // histórico), e é justamente por isso que o guard precisa estar aqui. Sem
  // ele, a odd pega no minuto 51 seria comparada com a linha que fechou no
  // minuto 0 e viraria CLV. Marca e sai; resultado pertence ao ciclo FlashScore.
  if (entrouAoVivo({
    registradoEm: bet.registradoEm,
    sourcePostedAt: bet.sourcePostedAt,
    kickoff: bet.data,
    kickoffInferido: bet.kickoffInferido,
    liveScoreHome: bet.liveScoreHome,
    liveScoreAway: bet.liveScoreAway,
  })) {
    return writeClosingOnce(bet, "fetchedAt", {
      clvReliable: false,
      noOddsReason: "aposta_ao_vivo",
      source: "CRON",
      fetchedAt: now,
    });
  }

  const odds = toNumber(bet.odds);
  const priceObservedAt = opts.priceObservedAt ?? now;
  // A mesma resposta traz a abertura: grava de graça (não bloqueia o CLV).
  await saveBridgeOpening({ bet, match, observedAt: priceObservedAt }).catch(() => false);
  // Jogo remarcado: antes do início (no horário da Bridge ou no da aposta) o
  // `closing` ainda se move. Adia sem congelar; a busca pós-jogo pega o
  // fechamento final.
  if (!bridgeClosingIsFinal(match, priceObservedAt, bet.kickoffInferido ? null : bet.data)) {
    log.info({ betId: bet.id, matchDate: match.match_date, horarioDaAposta: bet.data.toISOString() },
      "fechamento Bridge adiado: o jogo ainda não começou no horário da Bridge ou no da aposta");
    return false;
  }
  // Os dois horários podem ser o velho (o Vincular sem a Pinnacle17, que tem o
  // atual pelo mesmo id): jogo que ela ainda dá por começar não congela.
  const gameStart = await bridgeMatchGameStart(match, bet.data);
  if (gameStart && gameStart.getTime() > priceObservedAt.getTime()) {
    log.info({ betId: bet.id, horarioDaAposta: bet.data.toISOString(), pinnacle17: gameStart.toISOString() },
      "fechamento Bridge adiado: a Pinnacle17 remarcou o jogo para depois do horário da aposta");
    return false;
  }
  const resolved = resolveBridgeOddsForBet(
    match,
    {
      mercado: bet.mercado,
      selecao: bet.selecao,
    },
    { observedAt: priceObservedAt, now },
  );

  if (resolved.ok && resolved.odds.current) {
    const { current } = resolved.odds;
    const priceReference = encodeBridgePriceReference(match.match_id);
    assertPriceProvenance({
      fair: current.fair,
      raw: current.raw,
      snapshot: current.snapshot,
      provider: "bridgeodds",
      reference: priceReference,
      requireReference: true,
      observedAt: priceObservedAt,
    }, "preço de fechamento BridgeOdds");
    const clv = percentualContraFair(odds, current.fair);
    const closed = await writeClosingOnce(bet, "fetchedAt", {
      closingOdd: current.fair,
      closingRawOdd: current.raw,
      closingPriceSnapshot: current.snapshot as Prisma.InputJsonValue,
      closingPriceReference: priceReference,
      closingPriceObservedAt: priceObservedAt,
      closingMaxBet: current.maxBet,
      closingMaxBetCurrency: current.maxBet == null
        ? null
        : maxBetCurrencyForProvider("bridgeodds"),
      clv,
      clvReliable: true,
      source: "CRON",
      provider: "bridgeodds",
      fetchedAt: now,
    }, { expectedOdds: odds });
    if (closed) {
      await sendOperatorNotification(
        `🔒 Fechamento · ${bet.evento}\n` +
          `${bet.selecao} @${odds}\n` +
          `Fechou em ${current.raw.toFixed(3)} (justa ${current.fair.toFixed(3)})\n` +
          (resolved.odds.opening ? `${linhaMovimento(resolved.odds.opening.fair, current.fair)}\n` : "") +
          linhaClv(clv),
        { key: `closing:${bet.id}` },
      );
    }
    return closed;
  }

  const rawReason = resolved.ok ? "sem_linha_atual" : resolved.reason;
  // stale_price interno (BRIDGEODDS_CURRENT_PRICE_MAX_AGE_MS 15min) mapeia para
  // no_prices persistido — simetria com Pinnacle17.
  const reason = rawReason === "stale_price" ? "no_prices" : rawReason;
  await writeClosingOnce(bet, "fetchedAt", {
    clvReliable: false,
    noOddsReason: reason,
    source: "CRON",
    fetchedAt: now,
  });
  log.info({ betId: bet.id, reason }, "fechamento sem referência confiável (clvReliable=false)");
  return false;
}
