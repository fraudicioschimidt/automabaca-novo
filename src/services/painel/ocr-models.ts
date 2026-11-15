import { READING_CORRECTED_ACTION, READING_FIELDS, type ReadingField } from "@/src/domain/bet-capture";
import { prisma } from "@/src/infra/prisma";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import type { LlmProviderId } from "@/src/infra/llm/cascade";
import { cascadeModels, googleVisionModelEnabled, PROVIDER_ORDER, type ProviderModels } from "@/src/infra/llm/models";
import { parkedLlmRoutes, type ParkedLlmRoute } from "@/src/infra/llm/route-cooldown";
import {
  buildComparisons,
  queryFairComparisons,
  queryItemBuckets,
  queryUnresolvedItems,
  type ComparisonPeriod,
} from "./ocr-models-comparison";

const log = createLogger("ocr-models-panel");
export type OcrModelRow = {
  provider: string; model: string; endpoint: string; enabled: boolean; scope: string;
  attempts: number; responses: number; accepted: number; complete: number; drafts: number;
  notBets: number; rejected: number; rateLimits: number; errors: number;
  fixedStake: number;
  /** Rejeições por motivo: `draft` = faltou odd/stake; `review` = conteúdo. */
  rejectedDraft: number; rejectedReview: number;
  averageMs: number | null; p95Ms: number | null; lastAt: string | null; lastResult: string | null; lastStatusCode: number | null;
  /** Tempo até uma leitura APTA — não conta rejeitadas nem respostas inúteis. */
  usefulAverageMs: number | null; usefulP95Ms: number | null; usefulSamples: number;
  inputTokens: number; outputTokens: number; reasoningTokens: number; pages: number;
  usageSamples: number; pricedSamples: number; paidEquivalentUsd: number | null;
  /** Custo estimado por leitura apta — separa "barato por chamada" de "barato por leitura". */
  costPerAcceptedUsd: number | null;
  reasons: Record<string, number>;
  /** Fora da rotação por modelo indisponível para a conta, até esta data. */
  parkedUntil: string | null;
  /** Em quantas credenciais (chaves) o modelo está fora da rotação. */
  parkedCredentials: number;
};

type Aggregate = {
  days: number; provider: string; model: string; endpoint: string; result: string; state: string | null; statusCode: number | null;
  attempts: number; responses: number; totalMs: number | null; durationSamples: number; p95Ms: number | null;
  usefulTotalMs: number | null; usefulSamples: number; usefulP95Ms: number | null;
  lastAt: Date; inputTokens: number; outputTokens: number; reasoningTokens: number; pages: number;
  usageSamples: number; pricedSamples: number; paidEquivalentUsd: number | null;
  fixedStakeSamples: number;
};

/**
 * Acerto conferido pelo dono, por leitor: apostas capturadas por ele e
 * quantas o dono corrigiu no painel, campo a campo. A remoção pelo painel não
 * entra: ela não diz se foi erro de leitura.
 */
export type ReaderAccuracyRow = {
  kind: "rule" | "llm";
  provider: string | null; model: string | null; endpoint: string | null; contractVersion: string | null;
  registered: number;
  /** Apostas com ao menos um campo da leitura corrigido. */
  corrected: number;
  fields: Record<ReadingField, number>;
};
export type OcrModelsReport = {
  available: boolean; evaluation: boolean; generatedAt: string;
  periods: Array<{ days: number; models: OcrModelRow[] }>;
  /** Comparação justa por item — ver `ocr-models-comparison`. */
  comparisons: ComparisonPeriod[];
  readers: Array<{ days: number; rows: ReaderAccuracyRow[] }>;
};

/**
 * As rotas de imagem da cascata, na ordem dela: visão, visão de precisão e o
 * OCR da Mistral. A web não recebe as chaves de IA, então habilitado é estar
 * no catálogo sem ter sido desligado por uma flag do env.
 */
export function configuredOcrReaders(): Array<Pick<OcrModelRow, "provider" | "model" | "endpoint" | "enabled" | "scope">> {
  const env = getEnv();
  const mistralOn = env.LLM_DISABLE_MISTRAL !== "1";
  const restricted = env.MISTRAL_CHAT_NARROW_ONLY === "1";
  const chatOn: Record<LlmProviderId, boolean> = {
    gemini: true, groq: env.LLM_DISABLE_GROQ !== "1", mistral: mistralOn && env.LLM_DISABLE_MISTRAL_CHAT !== "1",
  };
  return PROVIDER_ORDER.flatMap((provider) => {
    const models = cascadeModels(provider);
    return [
      ...[...new Set([...models.vision, ...models.precisionVision])].map((model) => ({
        provider, model, endpoint: provider === "gemini" ? "generate" : "chat", enabled: chatOn[provider],
        scope: provider === "mistral" && restricted ? "Bilhete compacto elegível" : imageScope(models, model),
      })),
      ...models.ocr.map((model) => ({ provider, model, endpoint: "ocr", enabled: mistralOn,
        scope: restricted ? "Bilhete compacto elegível" : "Uma seleção em uma imagem" })),
    ];
  });
}

function imageScope(models: ProviderModels, model: string): string {
  const vision = models.vision.includes(model);
  const precision = models.precisionVision.includes(model);
  return vision && precision ? "Imagem e visão detalhada" : vision ? "Imagem comum" : "Visão detalhada";
}

export function buildOcrModelPeriods(aggregates: Aggregate[], configured = configuredOcrReaders(), parked: ParkedLlmRoute[] = []): OcrModelsReport["periods"] {
  return [1, 7, 30].map((days) => {
    const models = new Map<string, OcrModelRow>();
    const key = (row: { provider: string; model: string; endpoint: string }) => `${row.provider}/${row.model}/${row.endpoint}`;
    const empty = (row: typeof configured[number]): OcrModelRow => ({ ...row,
      attempts: 0, responses: 0, accepted: 0, complete: 0, drafts: 0, notBets: 0, rejected: 0, rateLimits: 0, errors: 0, fixedStake: 0,
      rejectedDraft: 0, rejectedReview: 0,
      averageMs: null, p95Ms: null, lastAt: null, lastResult: null, lastStatusCode: null,
      usefulAverageMs: null, usefulP95Ms: null, usefulSamples: 0,
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0, pages: 0, usageSamples: 0, pricedSamples: 0, paidEquivalentUsd: null,
      costPerAcceptedUsd: null, reasons: {}, parkedUntil: null, parkedCredentials: 0,
    });
    for (const row of configured) models.set(key(row), empty(row));
    const durations = new Map<string, { total: number; samples: number }>();
    const usefulDurations = new Map<string, { total: number; samples: number }>();
    for (const aggregate of aggregates.filter((row) => row.days === days)) {
      if (aggregate.provider === "gemini" && !googleVisionModelEnabled(aggregate.model)) {
        continue;
      }
      if (aggregate.provider === "groq" && !/qwen3\.8|vision/i.test(aggregate.model)) {
        continue;
      }
      // Preserve the exact requested model in historical rows; never relabel an
      // old `latest` call with today's alias target.
      const id = key(aggregate);
      const row = models.get(id) ?? empty({ ...aggregate, enabled: false, scope: "Histórico" });
      row.attempts += aggregate.attempts; row.responses += aggregate.responses;
      if (aggregate.result === "accepted") {
        row.accepted += aggregate.attempts;
        row.fixedStake += aggregate.fixedStakeSamples;
        if (aggregate.state === "complete") row.complete += aggregate.attempts;
        if (aggregate.state === "draft") row.drafts += aggregate.attempts;
        if (aggregate.state === "not_bet") row.notBets += aggregate.attempts;
      } else if (["rejected", "ocr_conflict"].includes(aggregate.result)) {
        row.rejected += aggregate.attempts;
        // O motivo vem no label: sem ele não se distingue "não achou a odd na
        // imagem" de "leu errado".
        if (aggregate.state === "draft") row.rejectedDraft += aggregate.attempts;
        else if (aggregate.state === "review") row.rejectedReview += aggregate.attempts;
      } else if (aggregate.result === "rate_limit") row.rateLimits += aggregate.attempts;
      else row.errors += aggregate.attempts;
      const reason = aggregate.statusCode && aggregate.statusCode >= 400 && aggregate.statusCode !== 429
        ? `${aggregate.result}:${aggregate.statusCode}` : aggregate.result;
      row.reasons[reason] = (row.reasons[reason] ?? 0) + aggregate.attempts;
      for (const field of ["inputTokens", "outputTokens", "reasoningTokens", "pages", "usageSamples", "pricedSamples"] as const) row[field] += aggregate[field];
      if (aggregate.paidEquivalentUsd !== null) row.paidEquivalentUsd = (row.paidEquivalentUsd ?? 0) + aggregate.paidEquivalentUsd;
      const duration = durations.get(id) ?? { total: 0, samples: 0 };
      duration.total += aggregate.totalMs ?? 0; duration.samples += aggregate.durationSamples;
      durations.set(id, duration);
      row.averageMs = duration.samples ? duration.total / duration.samples : null;
      // SQL computes one pooled p95 per model/window, repeated on result rows.
      row.p95Ms = aggregate.p95Ms;
      const useful = usefulDurations.get(id) ?? { total: 0, samples: 0 };
      useful.total += aggregate.usefulTotalMs ?? 0; useful.samples += aggregate.usefulSamples;
      usefulDurations.set(id, useful);
      row.usefulAverageMs = useful.samples ? useful.total / useful.samples : null;
      row.usefulSamples = useful.samples;
      row.usefulP95Ms = aggregate.usefulP95Ms;
      if (row.lastAt === null || aggregate.lastAt.toISOString() > row.lastAt) {
        row.lastAt = aggregate.lastAt.toISOString(); row.lastResult = aggregate.result; row.lastStatusCode = aggregate.statusCode;
      }
      models.set(id, row);
    }
    for (const row of models.values()) {
      row.costPerAcceptedUsd = row.accepted > 0 && row.paidEquivalentUsd !== null
        ? row.paidEquivalentUsd / row.accepted : null;
    }
    for (const route of parked) {
      const row = models.get(key(route));
      if (!row) continue;
      row.parkedUntil = route.until.toISOString();
      row.parkedCredentials = route.credentials;
    }
    return { days, models: [...models.values()] };
  });
}

export async function getOcrModelsReport(): Promise<OcrModelsReport> {
  const base = { evaluation: getEnv().LLM_VISION_EVALUATION === "1", generatedAt: new Date().toISOString() };
  try {
    const [rows, fair, items, unresolved, parked, readers] = await Promise.all([
      queryAttempts(), queryFairComparisons(), queryItemBuckets(), queryUnresolvedItems(), parkedLlmRoutes(), queryReaderAccuracy(),
    ]);
    return {
      ...base, available: true,
      periods: buildOcrModelPeriods(rows, configuredOcrReaders(), parked),
      comparisons: buildComparisons(fair, items, unresolved),
      readers: buildReaderAccuracy(readers),
    };
  } catch (err) {
    log.warn({ err }, "Relatório de modelos OCR indisponível");
    return { ...base, available: false, periods: [], comparisons: [], readers: [] };
  }
}

type ReaderAggregate = Omit<ReaderAccuracyRow, "fields" | "kind"> & { days: number; kind: string } & Record<ReadingField, number>;

export function buildReaderAccuracy(aggregates: ReaderAggregate[]): OcrModelsReport["readers"] {
  return [1, 7, 30].map((days) => ({
    days,
    rows: aggregates
      .filter((row) => row.days === days)
      .map((row): ReaderAccuracyRow => ({
        kind: row.kind === "rule" ? "rule" : "llm",
        provider: row.provider, model: row.model, endpoint: row.endpoint, contractVersion: row.contractVersion,
        registered: row.registered, corrected: row.corrected,
        fields: Object.fromEntries(READING_FIELDS.map((field) => [field, row[field]])) as Record<ReadingField, number>,
      }))
      .sort((a, b) => b.registered - a.registered || b.corrected - a.corrected),
  }));
}

/** Janela pela data da captura; a correção conta em qualquer data posterior. */
function queryReaderAccuracy(): Promise<ReaderAggregate[]> {
  return prisma.$queryRaw<ReaderAggregate[]>`
    WITH captured AS (
      SELECT p.days, b.id, b."captureReader" AS reader
      FROM bets b CROSS JOIN (VALUES (1), (7), (30)) p(days)
      WHERE b."captureReader" IS NOT NULL
        AND b."registradoEm" >= NOW() - INTERVAL '30 days'
        AND b."registradoEm" >= NOW() - p.days * INTERVAL '1 day'
    ), corrected AS (
      SELECT e."resourceId" AS bet_id, array_agg(DISTINCT field) AS fields
      FROM audit_events e CROSS JOIN LATERAL jsonb_array_elements_text(e.details->'fields') AS field
      WHERE e.action = ${READING_CORRECTED_ACTION} AND e.resource = 'bet'
        AND e."createdAt" >= NOW() - INTERVAL '30 days'
      GROUP BY e."resourceId"
    )
    SELECT c.days, c.reader->>'kind' AS kind, c.reader->>'provider' AS provider, c.reader->>'model' AS model,
      c.reader->>'endpoint' AS endpoint, c.reader->>'contractVersion' AS "contractVersion",
      COUNT(*)::int AS registered, COUNT(x.bet_id)::int AS corrected,
      COUNT(*) FILTER (WHERE 'evento' = ANY(x.fields))::int AS evento,
      COUNT(*) FILTER (WHERE 'mercado' = ANY(x.fields))::int AS mercado,
      COUNT(*) FILTER (WHERE 'selecao' = ANY(x.fields))::int AS selecao,
      COUNT(*) FILTER (WHERE 'linha' = ANY(x.fields))::int AS linha,
      COUNT(*) FILTER (WHERE 'odds' = ANY(x.fields))::int AS odds,
      COUNT(*) FILTER (WHERE 'stake' = ANY(x.fields))::int AS stake
    FROM captured c LEFT JOIN corrected x ON x.bet_id = c.id
    GROUP BY 1, 2, 3, 4, 5, 6
  `;
}

function queryAttempts(): Promise<Aggregate[]> {
  return prisma.$queryRaw<Aggregate[]>`
    WITH attempts AS (
      SELECT p.days, m.*, m.labels->>'provider' AS provider, m.labels->>'model' AS model,
        m.labels->>'endpoint' AS endpoint, m.labels->>'result' AS result, m.labels->>'extractionState' AS state,
        (m."statusCode" BETWEEN 200 AND 299) AS response
      FROM operational_metrics m CROSS JOIN (VALUES (1), (7), (30)) p(days)
      WHERE m.kind = 'provider' AND m.name = 'llm.attempt' AND m.labels->>'modality' = 'image'
        AND m."occurredAt" >= NOW() - INTERVAL '30 days'
        AND m."occurredAt" >= NOW() - p.days * INTERVAL '1 day'
    ), latency AS (
      SELECT days, provider, model, endpoint,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs") FILTER (WHERE response) AS p95,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs")
          FILTER (WHERE result = 'accepted') AS "p95useful"
      FROM attempts GROUP BY days, provider, model, endpoint
    )
    SELECT a.days, a.provider, a.model, a.endpoint, a.result, a.state, a."statusCode",
      COUNT(*)::int AS attempts, COUNT(*) FILTER (WHERE response)::int AS responses,
      SUM("durationMs") FILTER (WHERE response)::float AS "totalMs",
      COUNT("durationMs") FILTER (WHERE response)::int AS "durationSamples", MAX(l.p95)::float AS "p95Ms",
      SUM("durationMs") FILTER (WHERE a.result = 'accepted')::float AS "usefulTotalMs",
      COUNT("durationMs") FILTER (WHERE a.result = 'accepted')::int AS "usefulSamples",
      MAX(l."p95useful")::float AS "usefulP95Ms",
      MAX("occurredAt") AS "lastAt",
      COUNT(*) FILTER (WHERE a.result = 'accepted' AND labels->>'stakePolicy' = 'ALWAYS')::int AS "fixedStakeSamples",
      COALESCE(SUM(CASE WHEN jsonb_typeof(labels->'inputTokens') = 'number' THEN (labels->>'inputTokens')::float END), 0) AS "inputTokens",
      COALESCE(SUM(CASE WHEN jsonb_typeof(labels->'outputTokens') = 'number' THEN (labels->>'outputTokens')::float END), 0) AS "outputTokens",
      COALESCE(SUM(CASE WHEN jsonb_typeof(labels->'reasoningTokens') = 'number' THEN (labels->>'reasoningTokens')::float END), 0) AS "reasoningTokens",
      COALESCE(SUM(CASE WHEN jsonb_typeof(labels->'pages') = 'number' THEN (labels->>'pages')::float END), 0) AS pages,
      COUNT(*) FILTER (WHERE labels ? 'inputTokens' OR labels ? 'pages')::int AS "usageSamples",
      COUNT(*) FILTER (WHERE jsonb_typeof(labels->'paidEquivalentUsd') = 'number')::int AS "pricedSamples",
      SUM(CASE WHEN jsonb_typeof(labels->'paidEquivalentUsd') = 'number' THEN (labels->>'paidEquivalentUsd')::float END) AS "paidEquivalentUsd"
    FROM attempts a JOIN latency l USING (days, provider, model, endpoint)
    GROUP BY a.days, a.provider, a.model, a.endpoint, a.result, a.state, a."statusCode"
  `;
}
