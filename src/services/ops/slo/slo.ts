import { OperationalRisk, Prisma } from "@/src/generated/prisma/client";
import { createLogger } from "@/src/infra/logger";
import { DAILY_METRIC } from "@/src/infra/operational-metrics";
import { prisma } from "@/src/infra/prisma";
import { persistOperationalAlert, sendOperationalAlert } from "@/src/services/ops/alerts";
import { ACTIVE_OPERATIONAL_ACTION_STATUSES } from "@/src/domain/operational-action-status";
import { closeGcActions } from "@/src/services/ops/action-resource-gc";
import { reconcileOperationalActionSource } from "@/src/services/ops/operational-actions";
import { reportSloLogs, withSampleCorrelationIds } from "@/src/services/ops/slo/slo-log";
import { mensagemSloViolado } from "@/src/services/ops/slo/slo-message";

const log = createLogger("ops-slo");

const METRIC_RETENTION_DAYS = 30;
const SLO_ALERT_COOLDOWN_MS = 60 * 60_000;
/** Série violada que para de mandar amostra fica aberta até este prazo sem nenhuma. */
const SLO_SILENT_SERIES_CLOSE_MS = 24 * 60 * 60_000;
const PURGE_BATCH_SIZE = 5_000;
const MAX_PURGE_BATCHES = 20;

type MetricAggregateRow = {
  kind: string;
  name: string;
  samples: bigint;
  successes: bigint;
  errors: bigint;
  retries: bigint;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  p95QueueLagMs: number | null;
  lastSeenAt: Date;
};

export type OperationalSloRow = {
  kind: string;
  name: string;
  samples: number;
  errors: number;
  retries: number;
  retryPct: number;
  successPct: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  p95QueueLagMs: number | null;
  lastSeenAt: Date;
  status: "healthy" | "warning" | "breach";
  reasons: string[];
  /** A série abre ação e avisa; as que ficam só no painel não pesam no veredito. */
  alerting: boolean;
};

const LIMITS = {
  queue: { successPct: 99, p95DurationMs: 120_000, p95QueueLagMs: 300_000 },
  provider: { successPct: 95, p95DurationMs: 15_000, p95QueueLagMs: null },
  action: { successPct: 99, p95DurationMs: 3_000, p95QueueLagMs: null },
  http: { successPct: 99.5, p95DurationMs: 3_000, p95QueueLagMs: null },
} as const;
const NAMED_DURATION_LIMITS_MS: Readonly<Record<string, number>> = {
  /**
   * BridgeOdds opera com soft-cap de 90 req/h (`BRIDGEODDS_REQUEST_COOLDOWN_MS = 40_000ms`).
   * Como a telemetria HTTP mede a espera de cadência global, cada requisição leva ~40s + rede
   * (é o p95 real); 60s dá ~50% de folga.
   */
  "provider:bridgeodds.opening-closing/:id": 60_000,
  "provider:bridgeodds.login": 60_000,
  /**
   * Cadência de provedor sincroniza chamadas sob o gate global (`awaitProviderCadence`).
   * Sob a cadência obrigatória da BridgeOdds (`BRIDGEODDS_REQUEST_COOLDOWN_MS = 40_000ms`),
   * chamadas que aguardam o próximo slot registram waitMs de ~40s com 100% de sucesso.
   * 60s acomoda o slot de 40s + margem de rede/lock sem mascarar travamentos reais.
   */
  "action:provider.cadence": 60_000,
  /**
   * Continuação de enrich sharp (`continueSharpEnrich`) agenda o reprocessamento diferido
   * quando a BridgeOdds está em cooldown de 40s ou aguardando abertura de linhas.
   * A métrica registra `durationMs: Math.max(0, startAfter.getTime() - Date.now())` (tempo agendado no pg-boss).
   * O p95 fica perto de 100s, todo expected_retry. 150s (2.5 min) cobre até 2–3 slots sequenciais do gate (80s–120s) com folga.
   */
  "action:sharp.continuation": 150_000,
  /**
   * Etapas de enrich que orquestram providers externos (Pinnacle17, Flashscore, BridgeOdds).
   * O default de action (3s) foi desenhado para mutações locais do Postgres. As chamadas
   * de rede dos provedores têm piso próprio de 15s (`LIMITS.provider.p95DurationMs = 15_000ms`).
   * 15s alinha as etapas ao limite dos próprios providers chamados.
   */
  "action:sharp.stage.identity": 15_000,
  "action:sharp.stage.identity_kickoff": 15_000,
  "action:sharp.stage.price": 15_000,
  /**
   * A resolução de esporte orquestra catálogos externos em cascata: varre Futebol e
   * Basquete no BridgeOdds (até 5 tentativas por esporte sob a cadência de 40s = ~400s),
   * seguido por FlashScore, Pinnacle17 e Web search.
   * 480s (8 min) cobre a varredura completa serial (p95 perto de 410s) com folga.
   */
  "action:sport.resolve": 480_000,
  "queue:capture.sport_resolve": 480_000,
  /**
   * `sharp.enrich` é BIMODAL por desenho. A cadência Bridge é global entre
   * web e worker: com concorrência legítima, uma chamada pode aguardar dois
   * slots do gate em vez de um.
   *
   * Sem erro nem retry, o p95 fica perto de 6 min e o p99 de 8 min. A fase Bridge tem orçamento
   * próprio na janela de entrada; 480s cobre essa contenção sem somar toda a janela financeira ao
   * limite de atraso da fila.
   */
  "queue:sharp.enrich": 480_000,
};
/**
 * Espera na fila acima do teto genérico de 5 min. `telegram.updates` é o post
 * do tipster esperando a captura: a entrada vale pouco se chega tarde, e a
 * espera inclui a do update anterior do mesmo post.
 */
const NAMED_QUEUE_LAG_LIMITS_MS: Readonly<Record<string, number>> = {
  "telegram.updates": 60_000,
};
/**
 * Guard composto: duração e atraso isolados podem estar abaixo de seus tetos
 * e, somados, consumirem a janela financeira. A soma dos p95 é conservadora
 * (não finge ser o percentil da soma), mas deixa cinco minutos de margem até
 * os 15 min em que uma cotação ainda pode representar a entrada.
 */
const NAMED_QUEUE_TOTAL_LIMITS_MS: Readonly<Record<string, number>> = {
  "sharp.enrich": 600_000,
};
type LlmSeries = {
  name: string; samples: number; errors: number; retries: number;
  successPct: number; p95DurationMs: number | null;
};
type Classification = Pick<OperationalSloRow, "status" | "reasons">;

/** Séries de LLM separam transporte do provider, qualidade da extração e a cascata inteira. */
export function classifyLlmSeries(row: LlmSeries): Classification | undefined {
  if (!row.name.startsWith("llm.")) return undefined;
  if (row.name === "llm.attempt") return { status: "warning", reasons: ["aceitação histórica; consultar transporte, conteúdo e cascata"] };
  if (row.samples < 5) return { status: "warning", reasons: ["amostra curta"] };
  if (row.name.startsWith("llm.content.")) {
    const acceptance = 100 * (row.samples - row.errors - row.retries) / row.samples;
    return row.errors || row.retries
      ? { status: "warning", reasons: [`aceitação ${acceptance.toFixed(1)}%; ${row.retries} revisões esperadas; ${row.errors} saídas inválidas`] }
      : { status: "healthy", reasons: [] };
  }
  // Physical HTTP budgets: Gemini 20s/search 35s, Groq 25s, Mistral OCR 15s/chat 30s.
  // Five minutes is the initial operational latency objective for the WHOLE
  // cascade (not a transport timeout); refine it with the new duration series.
  const durationLimit = row.name === "llm.cascade" ? 300_000
    : row.name === "llm.transport.gemini.search" ? 35_000
    : row.name === "llm.transport.mistral.ocr" ? 15_000
    : row.name.startsWith("llm.transport.gemini.") ? 20_000
      : row.name.startsWith("llm.transport.groq.") ? 25_000 : 30_000;
  const reasons: string[] = [];
  if (row.successPct < 95) reasons.push(`sucesso ${row.successPct.toFixed(1)}% < 95%`);
  if (row.p95DurationMs !== null && row.p95DurationMs > durationLimit) reasons.push(`p95 ${Math.round(row.p95DurationMs)}ms > ${durationLimit}ms`);
  return { status: reasons.length ? "breach" : "healthy", reasons };
}

const RETRY_STORM_MIN_SAMPLES = 5;
const RETRY_STORM_PCT = 50;

export function classify(row: Omit<OperationalSloRow, "status" | "reasons" | "alerting">): Pick<OperationalSloRow, "status" | "reasons"> {
  const llm = row.kind === "provider" ? classifyLlmSeries(row) : undefined;
  if (llm) return llm;
  // A série `<provider>.breaker` registra a ABERTURA do circuito (uma amostra
  // por trip), não a chamada recusada. Ela vem ANTES do piso de amostras: um
  // trip isolado é incidente, não "amostra curta" — e zero trip na janela é
  // saudável, porque não há taxa de disponibilidade para medir aqui (aplicar o
  // piso genérico de 95% daria 0% por construção).
  if (row.kind === "provider" && row.name.endsWith(".breaker")) {
    return row.errors > 0
      ? {
          status: "breach",
          reasons: [`circuito do provider abriu ${row.errors} ${row.errors === 1 ? "vez" : "vezes"} na janela`],
        }
      : { status: "healthy", reasons: [] };
  }
  const limits = LIMITS[row.kind as keyof typeof LIMITS];
  if (!limits || row.samples < 5) return { status: "warning", reasons: ["amostra curta"] };
  const durationLimitMs =
    NAMED_DURATION_LIMITS_MS[`${row.kind}:${row.name}`] ?? limits.p95DurationMs;
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (row.successPct < limits.successPct) {
    // Para limits.successPct = 95%, qualquer série com < 20 amostras viola matematicamente
    // o piso com um único erro isolado (ex.: 5 sucessos e 1 timeout = 83.3% < 95%).
    // Exigir >= 2 erros ou amostra robusta (>= 20) evita abrir incidente durável por ruído
    // de rede transiente, mantendo a visibilidade como warning.
    const isStatisticallySignificant = row.kind !== "provider" || row.errors >= 2 || row.samples >= 20;
    if (isStatisticallySignificant) {
      reasons.push(`sucesso ${row.successPct.toFixed(1)}% < ${limits.successPct}%`);
    } else {
      warnings.push(`falha isolada em amostra reduzida (${row.errors}/${row.samples} amostras)`);
    }
  }
  if (row.p95DurationMs != null && row.p95DurationMs > durationLimitMs) {
    reasons.push(`p95 ${Math.round(row.p95DurationMs)}ms > ${durationLimitMs}ms`);
  }
  const queueLagLimitMs = (row.kind === "queue" ? NAMED_QUEUE_LAG_LIMITS_MS[row.name] : undefined)
    ?? limits.p95QueueLagMs;
  if (queueLagLimitMs != null && row.p95QueueLagMs != null && row.p95QueueLagMs > queueLagLimitMs) {
    reasons.push(`atraso p95 ${Math.round(row.p95QueueLagMs)}ms > ${queueLagLimitMs}ms`);
  }
  const totalQueueLimitMs = row.kind === "queue"
    ? NAMED_QUEUE_TOTAL_LIMITS_MS[row.name]
    : undefined;
  if (
    totalQueueLimitMs != null &&
    row.p95DurationMs != null &&
    row.p95QueueLagMs != null &&
    row.p95DurationMs + row.p95QueueLagMs > totalQueueLimitMs
  ) {
    reasons.push(
      `atraso+execução p95 ${Math.round(row.p95DurationMs + row.p95QueueLagMs)}ms > ${totalQueueLimitMs}ms`,
    );
  }
  if (
    row.kind === "queue" &&
    row.retries >= RETRY_STORM_MIN_SAMPLES &&
    row.retryPct > RETRY_STORM_PCT
  ) {
    reasons.push(`retentativas ${row.retryPct.toFixed(1)}% > ${RETRY_STORM_PCT}%`);
  }
  if (reasons.length > 0) return { status: "breach", reasons };
  if (warnings.length > 0) return { status: "warning", reasons: warnings };
  return { status: "healthy", reasons: [] };
}

export async function getOperationalSlos(hours = 24): Promise<OperationalSloRow[]> {
  const intervalHours = Math.max(1, Math.min(168, Math.floor(hours)));
  const rows = await prisma.$queryRaw<MetricAggregateRow[]>`
    SELECT kind, name,
      count(*)::bigint AS samples,
      count(*) FILTER (WHERE outcome = 'success')::bigint AS successes,
      count(*) FILTER (WHERE outcome = 'error')::bigint AS errors,
      count(*) FILTER (WHERE outcome = 'expected_retry')::bigint AS retries,
      avg("durationMs")::float8 AS "avgDurationMs",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs")::float8 AS "p95DurationMs",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY "queueLagMs")::float8 AS "p95QueueLagMs",
      max("occurredAt") AS "lastSeenAt"
    FROM operational_metrics
    WHERE "occurredAt" >= now() - (${intervalHours}::text || ' hours')::interval
      AND outcome IN ('success', 'error', 'expected_retry')
      AND labels->>'sampling' IS DISTINCT FROM 'errors_only'
    GROUP BY kind, name
    ORDER BY kind, name
  `;
  return rows.map((raw) => {
    const samples = Number(raw.samples);
    const successes = Number(raw.successes);
    const errors = Number(raw.errors);
    const retries = Number(raw.retries);
    const terminalSamples = successes + errors;
    const base = {
      kind: raw.kind,
      name: raw.name,
      samples,
      errors,
      retries,
      retryPct: samples > 0 ? (retries / samples) * 100 : 0,
      successPct: terminalSamples > 0 ? (successes / terminalSamples) * 100 : 100,
      avgDurationMs: raw.avgDurationMs,
      p95DurationMs: raw.p95DurationMs,
      p95QueueLagMs: raw.p95QueueLagMs,
      lastSeenAt: raw.lastSeenAt,
    };
    return { ...base, ...classify(base), alerting: !llmPanelOnly(base) };
  });
}

/**
 * Séries de IA que ficam só no painel. `llm.attempt` não tem denominador de
 * disponibilidade; o transporte de um provedor falha e a cascata cobre com o
 * seguinte. Quem alerta é o desfecho: `llm.cascade` (cascata inteira sem
 * leitura, ou lenta) e o SLO das filas que esperam a leitura.
 */
function llmPanelOnly(row: Pick<OperationalSloRow, "kind" | "name">): boolean {
  return row.kind === "provider" && (row.name === "llm.attempt" || row.name.startsWith("llm.transport."));
}

/**
 * Ação de SLO aberta cuja série sumiu da janela de 1 h. Sem amostra não há
 * prova de recuperação: a fila que parou de rodar some da janela justamente
 * quando está pior. A ação fica aberta enquanto a série teve amostra nas
 * últimas 24 h, e só se recupera com amostra saudável na janela (o que já
 * exige 5 amostras, `classify`). Passadas 24 h sem nada, fecha dizendo isso.
 * A série `.breaker` é a exceção: ela só grava abertura de circuito, e a
 * ausência é o estado saudável.
 */
async function silentSloActions(presentKeys: ReadonlySet<string>, now: Date): Promise<{
  keepOpen: string[];
  expired: Array<{ id: string; fingerprint: string }>;
}> {
  const open = await prisma.operationalAction.findMany({
    where: {
      fingerprint: { startsWith: "slo:" },
      status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] },
      resource: { not: null },
      resourceId: { not: null },
    },
    select: { id: true, fingerprint: true, resource: true, resourceId: true },
  });
  const silent = open.flatMap((action) => {
    const key = `${action.resource}:${action.resourceId}`;
    return presentKeys.has(key) || action.resourceId?.endsWith(".breaker")
      ? []
      : [{ ...action, key, kind: action.resource ?? "", name: action.resourceId ?? "" }];
  });
  if (silent.length === 0) return { keepOpen: [], expired: [] };
  const recent = await prisma.$queryRaw<Array<{ kind: string; name: string }>>(Prisma.sql`
    SELECT DISTINCT kind, name FROM operational_metrics
    WHERE "occurredAt" >= ${new Date(now.getTime() - SLO_SILENT_SERIES_CLOSE_MS)}
      AND (kind, name) IN (${Prisma.join(silent.map((action) => Prisma.sql`(${action.kind}, ${action.name})`))})
  `);
  const withRecentSamples = new Set(recent.map((row) => `${row.kind}:${row.name}`));
  return {
    keepOpen: silent.filter((action) => withRecentSamples.has(action.key)).map((action) => action.key),
    expired: silent.filter((action) => !withRecentSamples.has(action.key))
      .map((action) => ({ id: action.id, fingerprint: action.fingerprint })),
  };
}

/** Avalia janela curta e alerta somente violações com amostra suficiente. */
export async function checkOperationalSlos(): Promise<{ checked: number; breaches: number }> {
  const rows = await getOperationalSlos(1);
  const breaches = rows.filter((row) => row.status === "breach" && row.alerting);
  const active = rows.filter((row) => row.status !== "healthy" && row.alerting);
  for (const row of breaches) {
    const resourceId = row.name.slice(0, 200);
    const message = mensagemSloViolado(row);
    const context = {
      source: "slo",
      key: `${row.kind}:${row.name}`,
      title: `SLO violado em ${row.name}`,
      risk: OperationalRisk.MEDIUM,
      resource: row.kind,
      resourceId: row.name,
      evidence: {
        samples: row.samples,
        errors: row.errors,
        retries: row.retries,
        retryPct: row.retryPct,
        reasons: row.reasons,
      },
    } as const;
    const recentAlert = await prisma.auditEvent.findFirst({
      where: {
        action: "observability.slo_breach",
        resource: row.kind,
        resourceId,
        createdAt: { gte: new Date(Date.now() - SLO_ALERT_COOLDOWN_MS) },
      },
      select: { id: true },
    });
    if (recentAlert) {
      // Cooldown evita novo toque/audit, não o estado durável do inbox. Sem
      // este refresh uma violação ativa poderia ficar uma hora sem ação alguma.
      await persistOperationalAlert(message, context, { incrementOccurrence: false });
      continue;
    }
    // A tentativa recusada mantém a ação aberta, sem iniciar uma hora de silêncio.
    if (!await sendOperationalAlert(message, context)) continue;
    await prisma.auditEvent.create({
      data: {
        actor: "system",
        action: "observability.slo_breach",
        resource: row.kind,
        resourceId,
        outcome: "error",
        details: {
          samples: row.samples,
          errors: row.errors,
          retries: row.retries,
          retryPct: row.retryPct,
          reasons: row.reasons,
        },
      },
    });
  }
  const now = new Date();
  const silent = await silentSloActions(new Set(rows.map((row) => `${row.kind}:${row.name}`)), now);
  await closeGcActions(
    silent.expired,
    "A série parou de mandar amostras há mais de 24 h: encerrada sem prova de recuperação.",
    now,
  );
  await reconcileOperationalActionSource("slo", [...active.map((row) => `${row.kind}:${row.name}`), ...silent.keepOpen], now);
  reportSloLogs(await withSampleCorrelationIds(rows));
  return { checked: rows.length, breaches: breaches.length };
}

/** Telemetria além da retenção; a série diária (`DAILY_METRIC`) fica. */
export async function purgeOldOperationalMetrics(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - METRIC_RETENTION_DAYS * 86_400_000);
  let deleted = 0;
  for (let batch = 0; batch < MAX_PURGE_BATCHES; batch += 1) {
    const count = await prisma.$executeRaw(Prisma.sql`
      DELETE FROM operational_metrics
      WHERE id IN (
        SELECT id FROM operational_metrics
        WHERE "occurredAt" < ${cutoff} AND kind <> ${DAILY_METRIC.kind}
        ORDER BY "occurredAt" ASC
        LIMIT ${PURGE_BATCH_SIZE}
      )
    `);
    deleted += count;
    if (count < PURGE_BATCH_SIZE) break;
  }
  if (deleted > 0) log.info({ deleted }, "telemetria antiga removida");
  return deleted;
}
