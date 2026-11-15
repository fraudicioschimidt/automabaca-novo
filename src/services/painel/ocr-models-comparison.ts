import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";

/**
 * Comparação por ITEM, não por tentativa. O carrossel para na primeira leitura
 * aceita, então um modelo só é tentado quando os anteriores falharam: a métrica
 * por tentativa premia quem quase não responde e pune quem recebe a sobra
 * difícil. Como a primeira posição é sorteada durante a
 * avaliação (`evaluationOrder`), a comparação registra o regime de cada
 * cascata. Variação do primeiro modelo sozinha não comprova sorteio.
 */
export type FairModelRow = {
  provider: string; model: string;
  /** Itens em que este modelo foi o primeiro sorteado. */
  assigned: number;
  /** Desses, quantos viraram leitura completa aceita. */
  accepted: number;
  /** Desses, quantos ao menos chegaram a produzir conteúdo (apta ou rejeitada). */
  produced: number;
  /** Intervalo de confiança 95% (Wilson) sobre `accepted / assigned`. */
  qualityLow: number | null; qualityHigh: number | null;
  /** Tentativas fora da primeira posição — a sobra da cascata. */
  rescueAttempts: number;
  /** Quantas dessas sobras este modelo salvou sozinho. */
  rescued: number;
  /** Itens resolvidos por outro modelo em que este rejeitou. */
  uniqueFailures: number;
};

export type TaskComparison = {
  task: string;
  /**
   * Todas as atribuições da tarefa têm prova de avaliação com ordem sorteada.
   * Histórico sem prova e períodos mistos não recebem esse estado.
   */
  randomized: boolean;
  items: number; resolved: number; withoutReading: number;
  models: FairModelRow[];
};

export type UnresolvedItem = {
  at: string; task: string; modelsTried: number;
  /** Referência curta da mensagem, quando o label a carrega. */
  chatIdHash: string | null; messageId: number | null;
};

export type ComparisonPeriod = {
  days: number;
  tasks: TaskComparison[];
  unresolved: UnresolvedItem[];
};

export type FairAggregate = {
  days: number; task: string; provider: string; model: string;
  assigned: number; accepted: number; produced: number;
  randomizedAssigned: number;
  rescueAttempts: number; rescued: number; uniqueFailures: number;
};
export type ItemAggregate = { days: number; task: string; resolved: boolean; modelsTried: number; items: number };
export type UnresolvedAggregate = {
  days: number; task: string; at: Date; modelsTried: number;
  chatIdHash: string | null; messageId: string | null;
};

/**
 * Intervalo de confiança de Wilson (95%). Com n pequeno o intervalo abre — é o
 * que impede eleger um modelo por 3 acertos em 4 tentativas.
 */
export function wilsonInterval(successes: number, trials: number, z = 1.96): { low: number; high: number } | null {
  if (!Number.isFinite(successes) || !Number.isFinite(trials) || trials <= 0) return null;
  const bounded = Math.max(0, Math.min(successes, trials));
  const p = bounded / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export function buildComparisons(
  fair: FairAggregate[],
  items: ItemAggregate[],
  unresolved: UnresolvedAggregate[],
  limit = 40,
): ComparisonPeriod[] {
  return [1, 7, 30].map((days) => {
    const tasks = new Map<string, TaskComparison>();
    const ensure = (task: string): TaskComparison => {
      const existing = tasks.get(task);
      if (existing) return existing;
      const created: TaskComparison = { task, randomized: false, items: 0, resolved: 0, withoutReading: 0, models: [] };
      tasks.set(task, created);
      return created;
    };
    for (const aggregate of fair.filter((row) => row.days === days)) {
      const task = ensure(aggregate.task);
      const interval = wilsonInterval(aggregate.accepted, aggregate.assigned);
      task.models.push({
        provider: aggregate.provider, model: aggregate.model,
        assigned: aggregate.assigned, accepted: aggregate.accepted, produced: aggregate.produced,
        qualityLow: interval?.low ?? null, qualityHigh: interval?.high ?? null,
        rescueAttempts: aggregate.rescueAttempts, rescued: aggregate.rescued,
        uniqueFailures: aggregate.uniqueFailures,
      });
    }
    for (const bucket of items.filter((row) => row.days === days)) {
      const task = ensure(bucket.task);
      task.items += bucket.items;
      if (bucket.resolved) task.resolved += bucket.items;
      else task.withoutReading += bucket.items;
    }
    for (const task of tasks.values()) {
      const assignments = fair.filter((row) => row.days === days && row.task === task.task && row.assigned > 0);
      task.randomized = assignments.length > 0 && assignments.every((row) => row.randomizedAssigned === row.assigned);
      task.models.sort((a, b) => b.assigned - a.assigned || b.accepted - a.accepted);
    }
    const list = unresolved
      .filter((row) => row.days === days)
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, limit)
      .map((row) => ({
        at: row.at.toISOString(), task: row.task, modelsTried: row.modelsTried,
        chatIdHash: row.chatIdHash, messageId: row.messageId === null ? null : Number(row.messageId),
      }));
    return { days, tasks: [...tasks.values()].sort((a, b) => b.items - a.items), unresolved: list };
  });
}

/**
 * Item = um `llmCallId` (uma extração). A posição do modelo dentro do item é a
 * ordem da primeira tentativa dele; só a posição 1 entra na amostra justa.
 * Fonte única para as três consultas: duas versões do mesmo conceito divergem.
 * A janela seleciona o item pela origem, depois de reunir suas tentativas:
 * cortar tentativas antes disso promoveria um fallback à primeira posição.
 * Sem origem gravada, usa a primeira tentativa observada na retenção de 30 dias.
 *
 * Entram as leituras de imagem e a de texto da captura (`channel-text`), cada
 * uma na sua tarefa. Resolver é ler a aposta completa: o consenso sobre um
 * rascunho ou sobre "não é aposta" também é aceito pela cascata, mas não é
 * leitura. Tarefa sem estado de extração (as releituras) resolve pelo aceite.
 */
const ITEM_ATTEMPTS = `
  attempt AS (
    SELECT m.labels->>'llmCallId' AS call_id, m.labels->>'task' AS task,
      m.labels->>'provider' AS provider, m.labels->>'model' AS model,
      m.labels->>'result' AS result, m.labels->>'extractionState' AS state, m."occurredAt" AS at,
      COALESCE(m.labels->'llmEvaluationRandomized' = 'true'::jsonb, false) AS randomized,
      CASE WHEN jsonb_typeof(m.labels->'llmCallStartedAtMs') = 'number' THEN
        CASE WHEN (m.labels->>'llmCallStartedAtMs')::numeric BETWEEN 0 AND 253402300799999 THEN
          LEAST(m."occurredAt", to_timestamp((m.labels->>'llmCallStartedAtMs')::double precision / 1000))
        END
      END AS call_started_at,
      m.labels->>'chatIdHash' AS chat_hash, m.labels->>'messageId' AS message_id
    FROM operational_metrics m
    WHERE m.kind = 'provider' AND m.name = 'llm.attempt'
      AND (m.labels->>'modality' = 'image' OR m.labels->>'task' = 'channel-text')
      AND m.labels->>'llmCallId' IS NOT NULL
      AND m."occurredAt" >= NOW() - INTERVAL '30 days'
  ), model_call AS (
    SELECT call_id, MIN(task) AS task, provider, model, MIN(at) AS first_at,
      MIN(COALESCE(call_started_at, at)) AS item_started_at,
      BOOL_AND(randomized) AS randomized,
      BOOL_OR(result = 'accepted' AND COALESCE(state, 'complete') = 'complete') AS accepted,
      BOOL_OR(result IN ('accepted', 'rejected')) AS produced,
      MAX(chat_hash) AS chat_hash, MAX(message_id) AS message_id
    FROM attempt GROUP BY call_id, provider, model
  ), call_summary AS (
    SELECT call_id, MIN(task) AS task, BOOL_OR(accepted) AS resolved,
      COUNT(*) AS "modelsTried", MIN(item_started_at) AS first_at
    FROM model_call GROUP BY call_id
  ), item AS (
    SELECT p.days, c.* FROM call_summary c CROSS JOIN (VALUES (1), (7), (30)) p(days)
    WHERE c.first_at >= NOW() - p.days * INTERVAL '1 day'
  ), ranked AS (
    SELECT i.days, mc.*, row_number() OVER (PARTITION BY i.days, mc.call_id ORDER BY mc.first_at, mc.provider, mc.model) AS pos
    FROM model_call mc JOIN item i ON i.call_id = mc.call_id
  )`;

export function queryFairComparisons(): Promise<FairAggregate[]> {
  return prisma.$queryRaw<FairAggregate[]>`
    WITH ${Prisma.raw(ITEM_ATTEMPTS)}
    SELECT r.days, r.task, r.provider, r.model,
      COUNT(*) FILTER (WHERE r.pos = 1)::int AS assigned,
      COUNT(*) FILTER (WHERE r.pos = 1 AND r.randomized)::int AS "randomizedAssigned",
      COUNT(*) FILTER (WHERE r.pos = 1 AND r.accepted)::int AS accepted,
      COUNT(*) FILTER (WHERE r.pos = 1 AND r.produced)::int AS produced,
      COUNT(*) FILTER (WHERE r.pos > 1)::int AS "rescueAttempts",
      COUNT(*) FILTER (WHERE r.pos > 1 AND r.accepted)::int AS rescued,
      COUNT(*) FILTER (WHERE NOT r.accepted AND i.resolved)::int AS "uniqueFailures"
    FROM ranked r JOIN item i ON i.days = r.days AND i.call_id = r.call_id
    GROUP BY r.days, r.task, r.provider, r.model
  `;
}

export function queryItemBuckets(): Promise<ItemAggregate[]> {
  return prisma.$queryRaw<ItemAggregate[]>`
    WITH ${Prisma.raw(ITEM_ATTEMPTS)}
    SELECT i.days, i.task, i.resolved, i."modelsTried"::int AS "modelsTried", COUNT(*)::int AS items
    FROM item i GROUP BY i.days, i.task, i.resolved, i."modelsTried"
  `;
}

export function queryUnresolvedItems(): Promise<UnresolvedAggregate[]> {
  return prisma.$queryRaw<UnresolvedAggregate[]>`
    WITH ${Prisma.raw(ITEM_ATTEMPTS)}
    SELECT i.days, i.task, MIN(i.first_at) AS at, COUNT(*)::int AS "modelsTried",
      MAX(mc.chat_hash) AS "chatIdHash", MAX(mc.message_id) AS "messageId"
    FROM item i JOIN model_call mc ON mc.call_id = i.call_id
    WHERE NOT i.resolved
    GROUP BY i.days, i.task, i.call_id
    ORDER BY MIN(i.first_at) DESC
    LIMIT 500
  `;
}
