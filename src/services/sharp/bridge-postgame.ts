import { entrouAoVivo } from "@/src/domain/entrada-ao-vivo";
import { toNumber } from "@/src/domain/money";
import { PERMANENT_NO_ODDS_REASONS, type NoOddsReason } from "@/src/domain/no-odds-reason";
import { percentualContraFair } from "@/src/domain/odds";
import { assertPriceProvenance } from "@/src/domain/price-provenance";
import {
  isBlockedProviderError,
  isRateLimitedProviderError,
  ProviderRequestError,
  ProviderRequestGateError,
} from "@/src/domain/provider-error";
import type { Prisma } from "@/src/generated/prisma/client";
import { CircuitOpenError } from "@/src/infra/circuit-breaker";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { BRIDGEODDS_COVERAGE } from "@/src/providers/bridgeodds/coverage-contract";
import { BridgeAnswerCappedError } from "@/src/providers/bridgeodds/match";
import { resolveBridgeOddsForBet } from "@/src/providers/bridgeodds/odds";
import type { BridgeQueryFn } from "@/src/providers/bridgeodds/scoring";
import { bridgeClosingIsFinal, encodeBridgePriceReference, type BridgeMatch } from "@/src/providers/bridgeodds/types";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { type BetAsRead, sameBetAsRead, writeClosingOnce } from "@/src/services/sharp/closing-guard";
import { resolveBridgePostgameMatch } from "@/src/services/sharp/closing/bridge-rematch";
import { bridgeMatchGameStart } from "@/src/services/sharp/enrich/apply-identity";
import { maxBetCurrencyForProvider } from "@/src/services/sharp/liquidity-currency";
import { getSegmentPhaseMap, isSegmentSharpOff } from "@/src/services/sharp/segment-policy";

/**
 * Busca pós-jogo na BridgeOdds (job `sharp.bridge_postgame`, a cada 20 min):
 * uma consulta por aposta grava a abertura (`bet_opening`) e o fechamento que
 * ainda falta (`bet_closing`), de 35 min depois do kickoff até 25 dias. A
 * BridgeOdds repassa o feed da Pinnacle com o mesmo id de evento e guarda as
 * duas linhas depois do jogo, então a mesma resposta serve às duas.
 *
 * Até 30 min depois do início, a aposta casada pela Bridge ainda tenta o
 * fechamento no `closing.sync`; daí em diante é aqui. O fechamento só troca o
 * que não tem CLV confiável: a linha sem preço (motivo não permanente) e a
 * cotação da Pinnacle17 sem CLV confiável. Placar nunca é gravado aqui: é do
 * ciclo FlashScore.
 *
 * Cada aposta tem até 6 consultas, espalhadas pela janela
 * (`POSTGAME_SCHEDULE_MS`, contadas em `bet_opening.attempts`), para jogo que a
 * Bridge ainda não lista não gastar a cota de 100/h. Só conta a consulta que a
 * Bridge respondeu; nenhum motivo é congelado quando a resposta não veio
 * inteira:
 * - a Bridge indisponível para qualquer consulta (cota, cadência, circuito
 *   aberto, credencial, 429) para o lote, e a aposta volta na rodada seguinte;
 * - o erro HTTP desta consulta pula só a aposta, sem contar a vez: ela espera o
 *   intervalo mínimo, e o lote segue;
 * - a resposta parada no nosso teto de páginas conta a vez (a Bridge respondeu,
 *   faltou alcance), o que limita o custo a 6 voltas por aposta; a última
 *   congela o que falta com `partida_nao_localizada`, para a aposta nunca
 *   ficar sem motivo.
 *
 * Toda escrita confere que a aposta ainda é a da leitura do lote: a editada
 * no meio da rodada não recebe a abertura, o fechamento nem a vez do jogo
 * antigo, e volta pela agenda com os termos novos.
 */

const log = createLogger("bridge-postgame");

/** Até aqui depois do início, a aposta da Bridge ainda é do `closing.sync`. */
export const BRIDGE_SYNC_AFTER_KICKOFF_MS = 30 * 60_000;
/** A Bridge ainda devolve jogos desta idade pela data. */
const WINDOW_MS = 25 * 86_400_000;
/**
 * Quando sai cada consulta, contada do kickoff: as mesmas 6 cobrem a janela
 * toda. A primeira espera 5 min além da última tentativa do `closing.sync`,
 * para a guarda de `fetchedAt` não recusar o fechamento que ele achou.
 */
const POSTGAME_SCHEDULE_MS = [
  35 * 60_000, 6 * 3_600_000, 24 * 3_600_000, 72 * 3_600_000, 7 * 86_400_000, 20 * 86_400_000,
] as const;
export const POSTGAME_MAX_ATTEMPTS = POSTGAME_SCHEDULE_MS.length;
/** A aposta que entrou tarde na fila não gasta duas consultas seguidas. */
const MIN_GAP_MS = 5 * 3_600_000;
/**
 * A Bridge aceita 100 chamadas por hora cheia. Lote pequeno a cada 20 min deixa
 * a maior parte da cota para a identidade de reserva e o `closing.sync`.
 */
const BATCH = 10;
/**
 * O job roda a cada 20 min e a fila o dá por perdido com 20 min
 * (`expireInSeconds`). Cada consulta espera o portão de ~40 s da Bridge: aos
 * 15 min a rodada para de pegar aposta nova, e a que já começou termina antes
 * do teto; o resto fica para a rodada seguinte.
 */
export const POSTGAME_STOP_TAKING_AFTER_MS = 15 * 60_000;

export type BridgePostgameResult = {
  checked: number;
  openings: number;
  closings: number;
  /** Apostas que continuaram sem o que faltava e contaram uma tentativa. */
  missing: number;
  /** Apostas cuja consulta deu erro HTTP: esperam o intervalo, sem gastar tentativa. */
  skipped: number;
  failures: number;
  /** Apostas do lote que ficaram para a rodada seguinte (prazo ou job cancelado). */
  deferred: number;
  /** A Bridge sem capacidade (circuito, cota) parou o lote. */
  stoppedBy: string | null;
  /** Outra rodada ainda estava em andamento, e esta não começou. */
  overlapped?: true;
};

export type BridgePostgameDeps = {
  now?: Date;
  query?: BridgeQueryFn;
  batchSize?: number;
  /** Do job do pg-boss: abortado quando o job expira ou o worker encerra. */
  signal?: AbortSignal;
  /** Relógio do prazo da rodada; injetável no teste. */
  clock?: () => number;
};

/**
 * Uma rodada por vez: o job que estoura o teto continua rodando depois que o
 * pg-boss o dá por perdido, e a retentativa (ou o disparo seguinte) começaria
 * outra em cima dela, disputando o mesmo portão e as mesmas apostas. O worker
 * é um processo só (advisory lock), então a trava do processo basta.
 */
let postgameInProgress = false;

const BRIDGE_MARKETS: Prisma.BetWhereInput = {
  OR: [
    { esporte: "Soccer", mercado: { in: [...BRIDGEODDS_COVERAGE.soccer.productMarkets] } },
    { esporte: "Basketball", mercado: { in: [...BRIDGEODDS_COVERAGE.basketball.productMarkets] } },
  ],
};

function isBridgeMarket(bet: { esporte: string; mercado: string }): boolean {
  const markets = bet.esporte === "Soccer" ? BRIDGEODDS_COVERAGE.soccer.productMarkets
    : bet.esporte === "Basketball" ? BRIDGEODDS_COVERAGE.basketball.productMarkets : [];
  return (markets as readonly string[]).includes(bet.mercado);
}

/** O fechamento que ainda pode ganhar preço da Bridge; o manual nunca é trocado. */
const CLOSING_IMPROVABLE: Prisma.BetWhereInput = {
  NOT: { closing: { is: { source: "MANUAL" } } },
  OR: [
    { closing: null },
    { closing: { is: { fetchedAt: null } } },
    { closing: { is: { closingOdd: null, OR: [
      { noOddsReason: null },
      { noOddsReason: { notIn: [...PERMANENT_NO_ODDS_REASONS] } },
    ] } } },
    // Cotação da Pinnacle17 sem CLV confiável (cedo demais, ou sem a linha nos
    // minutos finais) não é o fechamento: o fechamento real da Bridge a troca.
    { closing: { is: { provider: "pinnacle17", clvReliable: false, closingOdd: { not: null }, source: { in: ["CRON", "REPROCESS"] } } } },
  ],
};

const postgameSelect = {
  id: true, evento: true, esporte: true, mercado: true, selecao: true, odds: true, data: true,
  registradoEm: true, sourcePostedAt: true, liveScoreHome: true, liveScoreAway: true, pais: true, competicao: true,
  sharp: { select: { provider: true, providerMatchId: true } },
  opening: { select: { openingOdd: true, attempts: true } },
  closing: { select: { fetchedAt: true, closingOdd: true, clvReliable: true, noOddsReason: true, provider: true,
    source: true, closingPriceObservedAt: true } },
} as const;
type PostgameBet = Prisma.BetGetPayload<{ select: typeof postgameSelect }>;

function closingImprovable(bet: PostgameBet): boolean {
  const c = bet.closing;
  if (!c) return true;
  if (c.source === "MANUAL") return false;
  if (!c.fetchedAt) return true;
  if (c.closingOdd == null) return c.noOddsReason == null || !(PERMANENT_NO_ODDS_REASONS as readonly string[]).includes(c.noOddsReason);
  return c.provider === "pinnacle17" && c.clvReliable === false && (c.source === "CRON" || c.source === "REPROCESS");
}

function openingMissing(bet: PostgameBet): boolean {
  return isBridgeMarket(bet) && !bet.evento.includes(" | ") && bet.opening?.openingOdd == null;
}

async function selectBets(now: Date, batchSize: number): Promise<PostgameBet[]> {
  return prisma.bet.findMany({
    where: {
      deletedAt: null,
      notTakenAt: null,
      sportResolutionStatus: "CONFIRMED",
      kickoffInferido: false,
      data: { gte: new Date(now.getTime() - WINDOW_MS), lte: new Date(now.getTime() - POSTGAME_SCHEDULE_MS[0]) },
      bankroll: { is: { sharpMode: "CLV_ONLY" } },
      sharp: { is: { identityStatus: { in: ["MATCHED", "MANUAL"] } } },
      AND: [
        { OR: [
          // A abertura: mercado que a Bridge cobre, de um jogo só.
          { AND: [BRIDGE_MARKETS, { NOT: { evento: { contains: " | " } } },
            { OR: [{ opening: null }, { opening: { is: { openingOdd: null } } }] }] },
          // O fechamento: aposta casada pela Bridge ou mercado que ela cobre.
          { AND: [{ OR: [{ sharp: { is: { provider: "bridgeodds" } } }, BRIDGE_MARKETS] }, CLOSING_IMPROVABLE] },
        ] },
        // A consulta seguinte da agenda já chegou, até o teto.
        { OR: [
          { opening: null },
          ...POSTGAME_SCHEDULE_MS.map((offsetMs, attempts) => ({
            data: { lte: new Date(now.getTime() - offsetMs) },
            opening: { is: { attempts,
              OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: new Date(now.getTime() - MIN_GAP_MS) } }] } },
          })),
        ] },
      ],
    },
    orderBy: { data: "asc" },
    take: batchSize,
    select: postgameSelect,
  });
}

/** A aposta ainda é a da leitura: a editada no meio da consulta recomeça do zero. */
async function stillAsRead(bet: BetAsRead): Promise<boolean> {
  return await prisma.bet.count({ where: sameBetAsRead(bet) }) > 0;
}

/**
 * Grava a abertura da Pinnacle que veio numa resposta da BridgeOdds. A
 * abertura não muda depois de publicada, então qualquer resposta serve, antes
 * ou depois do jogo: quem já tem a resposta em mãos (fechamento pela Bridge no
 * `closing.sync`) grava de graça. Não sobrescreve abertura já gravada, nem
 * grava na aposta que mudou desde a leitura. Devolve se gravou.
 */
export async function saveBridgeOpening(params: {
  bet: BetAsRead;
  match: BridgeMatch;
  observedAt: Date;
}): Promise<boolean> {
  const { bet } = params;
  // `now = observedAt`: o limite de frescor vale para preço atual, não para a
  // abertura, que é fixa.
  const resolved = resolveBridgeOddsForBet(params.match, { mercado: bet.mercado, selecao: bet.selecao },
    { observedAt: params.observedAt, now: params.observedAt });
  const opening = resolved.ok ? resolved.odds.opening : null;
  if (!opening) return false;
  const reference = encodeBridgePriceReference(params.match.match_id);
  assertPriceProvenance({
    fair: opening.fair,
    raw: opening.raw,
    snapshot: opening.snapshot,
    provider: "bridgeodds",
    reference,
    requireReference: true,
    observedAt: params.observedAt,
  }, "abertura BridgeOdds");
  const data = {
    provider: "bridgeodds",
    priceReference: reference,
    openingOdd: opening.fair,
    openingRawOdd: opening.raw,
    openingPriceSnapshot: opening.snapshot as unknown as Prisma.InputJsonValue,
    openingPriceObservedAt: params.observedAt,
    openingMaxBet: opening.maxBet,
    openingMaxBetCurrency: opening.maxBet == null ? null : maxBetCurrencyForProvider("bridgeodds"),
    noOpeningReason: null,
  };
  if (!await stillAsRead(bet)) return false;
  const updated = await prisma.betOpening.updateMany({ where: { betId: bet.id, openingOdd: null }, data });
  if (updated.count > 0) return true;
  const created = await prisma.betOpening.createMany({ data: [{ betId: bet.id, ...data }], skipDuplicates: true });
  return created.count > 0;
}

/** Congela, uma vez, o fechamento que a Bridge não deu, com o motivo dela. */
async function freezeWithoutPrice(bet: PostgameBet, reason: NoOddsReason, now: Date): Promise<void> {
  if (bet.closing?.fetchedAt) return;
  await writeClosingOnce(bet, "fetchedAt", { clvReliable: false, noOddsReason: reason, source: "REPROCESS", fetchedAt: now });
}

/**
 * O fechamento da Bridge na resposta; sem ele, o motivo. Jogo que ainda não
 * começou na Bridge (remarcado depois do casamento) não grava nem congela: o
 * `closing` é a linha atual, e o ponto seguinte da agenda pega o final.
 */
async function saveBridgeClosing(bet: PostgameBet, match: BridgeMatch, observedAt: Date, now: Date):
  Promise<NoOddsReason | "saved" | "race" | "not_started"> {
  if (!bridgeClosingIsFinal(match, observedAt, bet.data)) return "not_started";
  // Os dois horários podem ser o velho; a Pinnacle17 tem o atual pelo mesmo id.
  const gameStart = await bridgeMatchGameStart(match, bet.data);
  if (gameStart && gameStart.getTime() > observedAt.getTime()) return "not_started";
  const resolved = resolveBridgeOddsForBet(match, { mercado: bet.mercado, selecao: bet.selecao });
  if (!resolved.ok || !resolved.odds.current) {
    const reason = resolved.ok ? "sem_linha_atual" : resolved.reason === "stale_price" ? "no_prices" : resolved.reason;
    await freezeWithoutPrice(bet, reason, now);
    return reason;
  }
  const { current } = resolved.odds;
  const priceReference = encodeBridgePriceReference(match.match_id);
  assertPriceProvenance({
    fair: current.fair,
    raw: current.raw,
    snapshot: current.snapshot,
    provider: "bridgeodds",
    reference: priceReference,
    requireReference: true,
    observedAt,
  }, "fechamento BridgeOdds pós-jogo");
  const odds = toNumber(bet.odds);
  const unreliableAt = bet.closing?.provider === "pinnacle17" && bet.closing.clvReliable === false
    && bet.closing.closingOdd != null ? bet.closing.closingPriceObservedAt : null;
  const wrote = await writeClosingOnce(bet, "closingOdd", {
    closingOdd: current.fair,
    closingRawOdd: current.raw,
    closingPriceSnapshot: current.snapshot as Prisma.InputJsonValue,
    closingPriceReference: priceReference,
    closingPriceObservedAt: observedAt,
    closingMaxBet: current.maxBet,
    closingMaxBetCurrency: current.maxBet == null ? null : maxBetCurrencyForProvider("bridgeodds"),
    clv: percentualContraFair(odds, current.fair),
    clvReliable: true,
    noOddsReason: null,
    source: "REPROCESS",
    provider: "bridgeodds",
    // Só preenche fetchedAt se ninguém congelou antes.
    ...(bet.closing?.fetchedAt ? {} : { fetchedAt: now }),
  }, { expectedOdds: odds, ...(unreliableAt ? { replacingUnreliableQuoteAt: unreliableAt } : {}) });
  return wrote ? "saved" : "race";
}

type ItemOutcome = { opening: boolean; closing: boolean; missing: boolean; skipped: boolean; failure?: string };

/** A Bridge indisponível para qualquer consulta: o lote para, sem gastar a vez das apostas. */
function bridgeUnavailable(error: unknown): boolean {
  if (error instanceof CircuitOpenError || error instanceof ProviderRequestGateError) return true;
  if (!(error instanceof ProviderRequestError)) return false;
  return isBlockedProviderError(error) || isRateLimitedProviderError(error) || error.status === 401 || error.status === 403;
}

/**
 * Conta uma consulta da aposta; o motivo é o da abertura, quando ela ainda
 * falta. A aposta editada no meio não herda a vez gasta no jogo antigo.
 */
async function recordAttempt(bet: BetAsRead, now: Date, openingReason: NoOddsReason | null): Promise<void> {
  if (!await stillAsRead(bet)) return;
  await prisma.betOpening.upsert({
    where: { betId: bet.id },
    create: { betId: bet.id, attempts: 1, lastAttemptAt: now, noOpeningReason: openingReason },
    update: { attempts: { increment: 1 }, lastAttemptAt: now, ...(openingReason ? { noOpeningReason: openingReason } : {}) },
  });
}

/** A consulta desta aposta deu erro HTTP: ela espera o intervalo mínimo, sem gastar tentativa. */
async function recordSkip(bet: BetAsRead, now: Date): Promise<void> {
  if (!await stillAsRead(bet)) return;
  await prisma.betOpening.upsert({
    where: { betId: bet.id },
    create: { betId: bet.id, lastAttemptAt: now },
    update: { lastAttemptAt: now },
  });
}

async function processBet(bet: PostgameBet, deps: BridgePostgameDeps, now: Date,
  phaseMap: Awaited<ReturnType<typeof getSegmentPhaseMap>>): Promise<ItemOutcome> {
  let needsOpening = openingMissing(bet);
  let needsClosing = closingImprovable(bet);
  const outcome: ItemOutcome = { opening: false, closing: false, missing: false, skipped: false };
  // Segmento com a medição de preço desligada: o fechamento congela sem
  // consulta. A vez conta, para a aposta não voltar a cada rodada.
  let segmentOff = false;
  if (needsClosing && isSegmentSharpOff(bet.esporte, bet.mercado, phaseMap)) {
    await freezeWithoutPrice(bet, "sharp_off", now);
    needsClosing = false;
    segmentOff = true;
  }
  // Entrada ao vivo não tem CLV a buscar; a abertura, se falta, ainda vale.
  if (needsClosing && entrouAoVivo({ registradoEm: bet.registradoEm, sourcePostedAt: bet.sourcePostedAt, kickoff: bet.data,
    liveScoreHome: bet.liveScoreHome, liveScoreAway: bet.liveScoreAway })) {
    await writeClosingOnce(bet, "closingOdd", {
      clvReliable: false, noOddsReason: "aposta_ao_vivo", source: "REPROCESS",
      ...(bet.closing?.fetchedAt ? {} : { fetchedAt: now }),
    });
    needsClosing = false;
  }
  if (!needsOpening && !needsClosing) {
    if (segmentOff) await recordAttempt(bet, now, null);
    return outcome;
  }

  let openingReason: NoOddsReason = "partida_nao_localizada";
  try {
    const observed = await resolveBridgePostgameMatch(bet, deps);
    if (!observed) {
      if (needsClosing) await freezeWithoutPrice(bet, "partida_nao_localizada", now);
    } else {
      if (needsOpening) {
        const saved = await saveBridgeOpening({ bet, match: observed.match, observedAt: observed.observedAt });
        if (saved) { outcome.opening = true; needsOpening = false; } else openingReason = "sem_abertura_na_linha";
      }
      if (needsClosing) {
        const closing = await saveBridgeClosing(bet, observed.match, observed.observedAt, now);
        if (closing === "saved") { outcome.closing = true; needsClosing = false; }
        // A corrida perdida é outra escrita que já resolveu o fechamento.
        if (closing === "race") needsClosing = false;
        // Na última vez da agenda o jogo que nunca começou fica explicado.
        if (closing === "not_started" && (bet.opening?.attempts ?? 0) + 1 >= POSTGAME_MAX_ATTEMPTS) {
          await freezeWithoutPrice(bet, "kickoff_sem_captura", now);
        }
      }
    }
  } catch (error) {
    if (bridgeUnavailable(error)) throw error;
    if (error instanceof ProviderRequestError) {
      log.warn({ betId: bet.id, status: error.status },
        "busca pós-jogo: a consulta desta aposta deu erro na Bridge — ela espera o intervalo, e o lote segue");
      await recordSkip(bet, now);
      outcome.skipped = true;
      return outcome;
    }
    if (error instanceof BridgeAnswerCappedError) {
      outcome.missing = true;
      const last = (bet.opening?.attempts ?? 0) + 1 >= POSTGAME_MAX_ATTEMPTS;
      if (last && needsClosing) await freezeWithoutPrice(bet, "partida_nao_localizada", now);
      await recordAttempt(bet, now, last && needsOpening ? "partida_nao_localizada" : null);
      return outcome;
    }
    log.warn({ err: error, betId: bet.id }, "busca pós-jogo: falha no item — segue o lote");
    openingReason = "falha_na_consulta";
    outcome.failure = error instanceof Error ? error.message : String(error);
    if (needsClosing) await freezeWithoutPrice(bet, "kickoff_sem_captura", now).catch(() => undefined);
  }
  if (needsOpening || needsClosing) {
    outcome.missing = true;
    await recordAttempt(bet, now, needsOpening ? openingReason : null);
  }
  return outcome;
}

export async function runBridgePostgameOnce(deps: BridgePostgameDeps = {}): Promise<BridgePostgameResult> {
  if (postgameInProgress) {
    log.warn("busca pós-jogo: a rodada anterior ainda está em andamento; esta não começa");
    return { checked: 0, openings: 0, closings: 0, missing: 0, skipped: 0, failures: 0, deferred: 0, stoppedBy: null, overlapped: true };
  }
  postgameInProgress = true;
  try {
    return await runBridgePostgame(deps);
  } finally {
    postgameInProgress = false;
  }
}

async function runBridgePostgame(deps: BridgePostgameDeps): Promise<BridgePostgameResult> {
  const now = deps.now ?? new Date();
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  const bets = await selectBets(now, deps.batchSize ?? BATCH);
  const phaseMap = await getSegmentPhaseMap();
  const result: BridgePostgameResult = { checked: 0, openings: 0, closings: 0, missing: 0, skipped: 0, failures: 0, deferred: 0, stoppedBy: null };
  const failures: string[] = [];
  for (const [index, bet] of bets.entries()) {
    if (deps.signal?.aborted === true || clock() - startedAt >= POSTGAME_STOP_TAKING_AFTER_MS) {
      result.deferred = bets.length - index;
      break;
    }
    let outcome: ItemOutcome;
    try {
      outcome = await processBet(bet, deps, now, phaseMap);
    } catch (error) {
      result.stoppedBy = error instanceof Error ? error.name : "unknown";
      result.deferred = bets.length - index;
      break;
    }
    result.checked += 1;
    if (outcome.opening) result.openings += 1;
    if (outcome.closing) result.closings += 1;
    if (outcome.missing) result.missing += 1;
    if (outcome.skipped) result.skipped += 1;
    if (outcome.failure) {
      result.failures += 1;
      if (failures.length < 10) failures.push(`• ${bet.evento}: ${outcome.failure}`);
    }
  }
  if (result.checked > 0 || result.deferred > 0) {
    log.info({ ...result, aborted: deps.signal?.aborted === true }, "busca pós-jogo na BridgeOdds");
  }
  if (result.failures > 0) {
    await sendOperationalAlert(
      `⚠️ Busca pós-jogo na BridgeOdds: ${result.failures} de ${result.checked} apostas com falha na consulta\n` +
        `${result.openings} aberturas e ${result.closings} fechamentos gravados nesta rodada.\n` +
        failures.join("\n") +
        "\n👉 Nada a fazer agora: cada aposta volta a ser consultada nos próximos pontos da agenda, até 20 dias depois do jogo. Feche este aviso em Monitoramento quando parar de repetir.",
      {
        source: "sharp.bridge_postgame",
        key: "batch-failure",
        title: "Falhas na busca pós-jogo na BridgeOdds",
        resource: "bridge-postgame",
        evidence: { failures: result.failures, checked: result.checked },
        autoResolve: false,
      },
    );
    await recordPartialRound(result);
  }
  return result;
}

/** A rodada com falha fica na auditoria: o vigia fecha o aviso depois de 24 h sem ela. */
async function recordPartialRound(result: BridgePostgameResult): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: { actor: "worker", action: "worker.bridge_postgame", resource: "sharp.bridge_postgame", outcome: "partial", details: result },
    });
  } catch (err) {
    log.error({ err }, "busca pós-jogo: falha ao gravar a auditoria");
  }
}
