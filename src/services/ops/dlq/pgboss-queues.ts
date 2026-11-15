import { prisma } from "@/src/infra/prisma";
import { Prisma } from "@/src/generated/prisma/client";

export type PgBossQueueNames = {
  sources: string[];
  deadLetters: string[];
};

/**
 * Relação canônica mantida pelo próprio pg-boss. Inclui filas órfãs ainda
 * registradas, portanto trocar LIKE por nomes exatos não esconde DLQ antiga.
 */
export async function getPgBossQueueNames(): Promise<PgBossQueueNames> {
  const rows = await prisma.$queryRaw<Array<{ name: string; deadLetter: string }>>`
    SELECT name, dead_letter AS "deadLetter"
    FROM pgboss.queue
    WHERE dead_letter IS NOT NULL
  `;
  return {
    sources: rows.map((row) => row.name),
    deadLetters: [...new Set(rows.map((row) => row.deadLetter))],
  };
}

export async function countActiveDeadLetters(since?: Date): Promise<number> {
  const { deadLetters } = await getPgBossQueueNames();
  if (deadLetters.length === 0) return 0;
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT count(*) AS n FROM pgboss.job
    WHERE name IN (${Prisma.join(deadLetters)})
      AND state IN ('created', 'retry', 'failed')
      ${since ? Prisma.sql`AND created_on > ${since}` : Prisma.empty}
  `);
  return Number(rows[0]?.n ?? 0);
}

export type PgBossFailureRow = {
  id: string;
  name: string;
  state: string;
  completed_on: Date | null;
  created_on: Date;
  /** O erro que matou o job; na dead-letter, o da origem (`source_output`). */
  output: unknown;
  /** Payload original — é dele que sai o `betId` da aposta afetada. */
  data: unknown;
  retry_count: number;
};

/**
 * Falhas: dead-letters ainda retidas, de qualquer idade (é trabalho pendente,
 * e o veredito as conta assim), e jobs `failed` das filas de origem desde
 * `since`. `output`/`data`/`retry_count` vêm na mesma linha e dizem POR QUÊ
 * falhou e de qual aposta.
 *
 * Ao esgotar as tentativas o pg-boss grava a mesma falha duas vezes: reinsere
 * a origem como `failed` e cria a cópia na dead-letter. Enquanto a cópia está
 * na fila, a falha aparece só por ela; a origem fica como histórico depois que
 * a cópia sai (replay, reenfileiramento ou descarte). O par é pelo payload: a
 * dead-letter retida antes do pg-boss 12.34 não tem `source_id`.
 *
 * Na dead-letter a causa é a `source_output` (o `output` é o da própria cópia:
 * vazio, ou o sentinela da retenção). Job de origem não tem `source_output`:
 * nada aqui usa o `redrive` do pg-boss, que é quem a levaria de volta.
 */
function recentFailureFilter(since: Date, sources: string[], deadLetters: string[]) {
  return Prisma.sql`
    WHERE job.name IN (${Prisma.join([...sources, ...deadLetters])})
      AND (
        (job.name IN (${Prisma.join(sources)}) AND job.state = 'failed' AND job.created_on > ${since} AND NOT EXISTS (
          SELECT 1 FROM pgboss.queue AS queue
          JOIN pgboss.job AS dlq ON dlq.name = queue.dead_letter
          WHERE queue.name = job.name
            AND dlq.state IN ('created', 'retry', 'failed')
            AND dlq.data IS NOT DISTINCT FROM job.data
        ))
        OR
        (job.name IN (${Prisma.join(deadLetters)}) AND job.state IN ('created', 'retry', 'failed'))
      )
  `;
}

export async function listRecentPgBossFailures(
  since: Date,
  limit: number,
): Promise<PgBossFailureRow[]> {
  const { sources, deadLetters } = await getPgBossQueueNames();
  if (sources.length === 0 && deadLetters.length === 0) return [];
  return prisma.$queryRaw<PgBossFailureRow[]>(Prisma.sql`
    SELECT job.id::text, job.name, job.state::text AS state, job.completed_on, job.created_on,
           COALESCE(job.source_output, job.output) AS output, job.data, job.retry_count
    FROM pgboss.job AS job
    ${recentFailureFilter(since, sources, deadLetters)}
    ORDER BY job.created_on DESC
    LIMIT ${Math.max(1, Math.min(Math.trunc(limit), 500))}
  `);
}

export async function countRecentPgBossFailures(since: Date): Promise<number> {
  const { sources, deadLetters } = await getPgBossQueueNames();
  if (sources.length === 0 && deadLetters.length === 0) return 0;
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT count(*) AS n FROM pgboss.job AS job
    ${recentFailureFilter(since, sources, deadLetters)}
  `);
  return Number(rows[0]?.n ?? 0);
}
