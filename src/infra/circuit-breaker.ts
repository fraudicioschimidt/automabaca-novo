import { createLogger } from "@/src/infra/logger";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { prisma } from "@/src/infra/prisma";
import {
  isBlockedProviderError,
  isRateLimitedProviderError,
  ProviderRequestGateError,
} from "@/src/domain/provider-error";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";

const log = createLogger("breaker");

/**
 * Circuit breaker por provider:
 * N falhas seguidas → OPEN (rejeita imediato) → após cooldown, HALF_OPEN
 * (1 sonda) → sucesso fecha, falha reabre. Protege o pipeline de ficar
 * pendurado em provider fora do ar.
 *
 * Estado no Postgres: web e worker veem o MESMO breaker. As
 * transições concorrentes usam UPDATE condicional (claim da sonda) e
 * INSERT ... ON CONFLICT (contagem de falha) — atômicos no banco.
 *
 * 429 e bloqueio anti-bot não incrementam falha estrutural: abrem cooldown
 * imediatamente, de forma uniforme para todos os providers.
 */

const FAILURE_THRESHOLD = 5;
/** Cooldown estrutural padrão. Providers com quota fixa podem exigir mais. */
const RESET_TIMEOUT_MS = 15 * 60_000;
/** Um 429 do BridgeOdds só ganhou nova capacidade na próxima janela horária. */
const BRIDGEODDS_RESET_TIMEOUT_MS = 60 * 60_000;

function resetTimeoutMs(name: string): number {
  return name === "bridgeodds" ? BRIDGEODDS_RESET_TIMEOUT_MS : RESET_TIMEOUT_MS;
}
// Lease inclui timeout e backoff do probe. A margem até 2min evita
// uma segunda chamada faturável durante execução normal, mas ainda recupera
// processo morto sem prender HALF_OPEN indefinidamente.
const PROBE_LEASE_MS = 2 * 60_000;

export async function resetBreakerForTests(name: string): Promise<void> {
  await prisma.providerCircuit.deleteMany({ where: { provider: name } });
}

export class CircuitOpenError extends Error {
  readonly provider: string;
  constructor(name: string) {
    super(`Circuit breaker aberto para "${name}"`);
    this.name = "CircuitOpenError";
    this.provider = name;
  }
}

type ClaimResult =
  | { allowed: true; priorState: "CLOSED" | "HALF_OPEN" }
  | { allowed: false; rejection: "cooldown" | "probe_in_flight" };

/**
 * Tenta autorizar uma requisição sob o circuit breaker do provider.
 *
 * CLOSED: passa direto (sem escrita).
 * HALF_OPEN: se lease expirou, estende e autoriza como sonda única; senão espera.
 * OPEN: dentro do cooldown rejeita; expirado, promove a HALF_OPEN atomicamente.
 */
async function claimGate(name: string): Promise<ClaimResult> {
  const row = await prisma.providerCircuit.findUnique({ where: { provider: name } });
  if (!row || row.state === "CLOSED") return { allowed: true, priorState: "CLOSED" };

  const now = Date.now();

  if (row.state === "HALF_OPEN") {
    // Sonda em voo: autoriza apenas se a anterior abandonou (lease expirado).
    const leaseCutoff = new Date(now - PROBE_LEASE_MS);
    const reclaimed = await prisma.providerCircuit.updateMany({
      where: { provider: name, state: "HALF_OPEN", updatedAt: { lte: leaseCutoff } },
      data: { updatedAt: new Date() },
    });
    return reclaimed.count > 0
      ? { allowed: true, priorState: "HALF_OPEN" }
      : { allowed: false, rejection: "probe_in_flight" };
  }

  // OPEN: dentro do cooldown rejeita; expirado, claim atômico da sonda (com lease).
  const cutoff = new Date(now - resetTimeoutMs(name));
  if (row.openedAt && row.openedAt > cutoff) {
    return { allowed: false, rejection: "cooldown" };
  }
  const claimed = await prisma.providerCircuit.updateMany({
    where: {
      provider: name,
      state: "OPEN",
      OR: [{ openedAt: null }, { openedAt: { lte: cutoff } }],
    },
    data: { state: "HALF_OPEN", updatedAt: new Date() },
  });
  if (claimed.count > 0) {
    log.info({
      eventCode: LOG_EVENTS.PROVIDER_CIRCUIT_HALF_OPEN,
      name,
      actionableHint: "Sonda única autorizada após cooldown; sucesso fecha, falha reabre.",
    }, "breaker em half-open — sondando");
    return { allowed: true, priorState: "HALF_OPEN" };
  }
  // Outro processo levou a sonda neste instante — este chamador espera. O
  // cooldown JÁ venceu, então isto é contenção pela sonda, não provider caído.
  return { allowed: false, rejection: "probe_in_flight" };
}

async function recordSuccess(name: string, priorState: string): Promise<void> {
  if (priorState === "CLOSED") {
    // Caminho quente: zera contagem só se houver algo a zerar (evita write por chamada).
    // `state: "CLOSED"` no WHERE é obrigatório: sem ele, uma request lenta que
    // começou com o breaker fechado e terminou depois de outras falhas o abrirem
    // ressuscitaria o breaker com um sucesso velho, escondendo uma queda real.
    await prisma.providerCircuit.updateMany({
      where: { provider: name, state: "CLOSED", failures: { gt: 0 } },
      data: { failures: 0, openedAt: null },
    });
    return;
  }
  const closed = await prisma.providerCircuit.updateMany({
    where: { provider: name, state: "HALF_OPEN" },
    data: { failures: 0, state: "CLOSED", openedAt: null },
  });
  if (closed.count > 0) {
    log.info({
      eventCode: LOG_EVENTS.PROVIDER_CIRCUIT_CLOSED,
      name,
      reason: "probe_success",
    }, "breaker fechado novamente");
  }
}

/**
 * A série `<provider>.breaker` mede ABERTURAS do circuito: uma amostra por trip.
 * O SLO trata `error` nessa série como violação, então a chamada RECUSADA no
 * cooldown não grava nada: o fan-out de settle/enrich viraria milhares de
 * linhas e o alerta dispararia em cima do próprio ruído.
 */
async function recordOpening(name: string, reason: string, failures: number): Promise<void> {
  await recordOperationalMetric({
    kind: "provider",
    name: `${name}.breaker`,
    outcome: "error",
    labels: { reason, failures, cooldownMs: resetTimeoutMs(name) },
  });
}

async function recordFailure(name: string): Promise<void> {
  // Relógio ÚNICO (Node): openedAt é comparado em claimGate com new Date();
  // misturar now() do Postgres com Date do JS deixou o cooldown à mercê do
  // timezone/parsing do servidor (bug pego no setup local com PG em UTC-3).
  const now = new Date();
  const rows = await prisma.$queryRaw<Array<{ state: string; failures: number }>>`
    INSERT INTO provider_circuits (provider, state, failures, "openedAt", "updatedAt")
    VALUES (${name}, 'CLOSED', 1, NULL, ${now})
    ON CONFLICT (provider) DO UPDATE SET
      failures = provider_circuits.failures + 1,
      state = CASE
        WHEN provider_circuits.state = 'HALF_OPEN'
          OR provider_circuits.failures + 1 >= ${FAILURE_THRESHOLD}
        THEN 'OPEN' ELSE provider_circuits.state END,
      "openedAt" = CASE
        WHEN provider_circuits.state = 'HALF_OPEN'
          OR provider_circuits.failures + 1 >= ${FAILURE_THRESHOLD}
        THEN ${now} ELSE provider_circuits."openedAt" END,
      "updatedAt" = ${now}
    RETURNING state, failures
  `;
  const after = rows[0];
  if (after?.state === "OPEN") {
    log.error({
      eventCode: LOG_EVENTS.PROVIDER_CIRCUIT_TRIPPED,
      name,
      failures: after.failures,
      threshold: FAILURE_THRESHOLD,
      cooldownMs: resetTimeoutMs(name),
      actionableHint: "Limite de falhas consecutivas atingido. Circuit breaker aberto para proteger o serviço.",
    }, "breaker ABERTO");
    await recordOpening(name, "consecutive_failures", after.failures);
  }
}

export async function withBreaker<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const gate = await claimGate(name);
  if (!gate.allowed) {
    // A recusa (cooldown ou sonda em voo) NÃO grava métrica: quem carrega o
    // incidente é a ABERTURA do circuito (`recordOpening`).
    throw new CircuitOpenError(name);
  }

  try {
    const result = await fn();
    await recordSuccess(name, gate.priorState);
    return result;
  } catch (err) {
    if (err instanceof CircuitOpenError || err instanceof ProviderRequestGateError) throw err;
    // 429 nao conta como falha estrutural no caminho normal. Numa sonda, porem,
    // ele prova que o provider ainda nao pode voltar: reabre pelo cooldown cheio
    // em vez de deixar HALF_OPEN reprovar a cada lease vencido.
    if (isBlockedProviderError(err) || isRateLimitedProviderError(err)) {
      const reason = isBlockedProviderError(err) ? "anti_bot_challenge" : "rate_limited";
      await tripBreaker(name, reason);
    } else {
      await recordFailure(name);
    }
    throw err;
  }
}

/** True se o breaker está OPEN dentro do cooldown (sem claim de sonda). */
export async function isBreakerOpen(name: string): Promise<boolean> {
  const row = await prisma.providerCircuit.findUnique({ where: { provider: name } });
  if (!row || row.state !== "OPEN") return false;
  // OPEN sem `openedAt` (linha legada / edição manual durante incidente) não tem
  // cooldown para expirar: tratar como "sempre aberto" prendia o breaker para
  // sempre, porque o claimGate compara `openedAt <= cutoff` e null nunca casa.
  // Sem instante de abertura, o cooldown já venceu.
  if (!row.openedAt) return false;
  return row.openedAt.getTime() > Date.now() - resetTimeoutMs(name);
}

/**
 * Fecha um breaker cujo cooldown JÁ venceu, após sucesso comprovado do provider.
 *
 * Existe para quem usa o par `isBreakerOpen`/`tripBreaker` em vez de
 * `withBreaker` (os clientes de LLM, o OCR da Mistral e o `chat-json`, que
 * precisam consultar o gate sem envolver a chamada). Esse par não tem o `recordSuccess` do caminho envolvido, então a
 * linha ficaria OPEN para sempre depois do primeiro trip, mesmo com o provider
 * respondendo (`isBreakerOpen` lê `openedAt`, não o campo `state`).
 *
 * A guarda de cooldown NÃO é detalhe: sem ela, uma request lenta que começou
 * antes de um trip e terminou depois apagaria um trip legítimo e recém-aberto.
 * Trip fresco fica intocado; só a lápide de um cooldown já expirado é limpa.
 */
export async function closeExpiredBreaker(name: string): Promise<void> {
  const cutoff = new Date(Date.now() - resetTimeoutMs(name));
  const cleared = await prisma.providerCircuit.updateMany({
    where: {
      provider: name,
      state: { not: "CLOSED" },
      // `openedAt` nulo = sem instante de abertura para expirar, logo o cooldown
      // já venceu — mesma leitura de `isBreakerOpen` e `claimGate`.
      OR: [{ openedAt: null }, { openedAt: { lte: cutoff } }],
    },
    data: { state: "CLOSED", failures: 0, openedAt: null },
  });
  if (cleared.count > 0) {
    log.info({
      eventCode: LOG_EVENTS.PROVIDER_CIRCUIT_CLOSED,
      name,
      reason: "expired_after_success",
    }, "breaker fechado após sucesso do provider");
  }
}

/** Força OPEN imediato (ex.: 429/quota) — próximo caller espera o cooldown. */
export async function tripBreaker(name: string, reason = "forced_trip"): Promise<void> {
  const now = new Date();
  await prisma.providerCircuit.upsert({
    where: { provider: name },
    create: { provider: name, state: "OPEN", failures: FAILURE_THRESHOLD, openedAt: now, updatedAt: now },
    update: { state: "OPEN", failures: FAILURE_THRESHOLD, openedAt: now, updatedAt: now },
  });
  log.error({
    eventCode: LOG_EVENTS.PROVIDER_CIRCUIT_TRIPPED,
    name,
    reason,
    cooldownMs: resetTimeoutMs(name),
    actionableHint: reason === "anti_bot_challenge"
      ? "Upstream retornou desafio anti-bot (Cloudflare/WAF). Circuit breaker aberto aguardando cooldown."
      : reason === "rate_limited"
        ? "Upstream retornou 429 (Too Many Requests). Circuit breaker aberto aguardando cooldown."
        : "Circuit breaker forçado para estado ABERTO.",
  }, "breaker ABERTO (trip)");
  await recordOpening(name, reason, FAILURE_THRESHOLD);
}