import "server-only";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { fonteDeFrescor, frescorDaFonte } from "@/src/domain/frescor";

const log = createLogger("operacoes");

type HealthAggregate = {
  heartbeat_completed_on: Date | null;
  closing_completed_on: Date | null;
};

export type SaudeMotor = {
  /**
   * O instante, não a idade: `workerVivo` e a tira de frescor derivam a idade
   * dele pelo mesmo `domain/frescor`, então não podem discordar.
   */
  ultimoHeartbeat: Date | null;
  ultimoClosing: Date | null;
  dbOk: boolean;
};

/** Worker considerado vivo conforme o mesmo limite da API e do monitor. */
export function workerVivo(saude: SaudeMotor, agora: Date = new Date()): boolean {
  return !frescorDaFonte(fonteDeFrescor("motor"), saude.ultimoHeartbeat, agora).atrasada;
}

/** Saúde resumida do motor — usada na pill do Dashboard e em Operações. */
export async function getSaudeMotor(): Promise<SaudeMotor> {
  try {
    const rows = await prisma.$queryRaw<HealthAggregate[]>`
      SELECT
        max(completed_on) FILTER (WHERE name = 'health.heartbeat') AS heartbeat_completed_on,
        max(completed_on) FILTER (WHERE name = 'closing.sync') AS closing_completed_on
      FROM pgboss.job
      WHERE name IN ('health.heartbeat', 'closing.sync') AND state = 'completed'
    `;
    const heartbeat = rows[0]?.heartbeat_completed_on ?? null;
    const closing = rows[0]?.closing_completed_on ?? null;
    return {
      ultimoHeartbeat: heartbeat,
      ultimoClosing: closing,
      dbOk: true,
    };
  } catch (err) {
    log.error({ mod: "operacoes-saude", err }, "falha ao ler saúde do motor (pgboss)");
    return { ultimoHeartbeat: null, ultimoClosing: null, dbOk: false };
  }
}
