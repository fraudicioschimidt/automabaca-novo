import "server-only";
import {
  type CausaDeFalha,
  betIdDoPayload,
  causaLabel,
  classificaCausa,
  providerDoCircuito,
  proximaEtapaDaCausa,
  replayResolveAgora,
} from "@/src/domain/falha-de-job";
import { FALHAS_DE_JOB_JANELA_DIAS, FALHAS_DE_JOB_LIMITE } from "@/src/domain/recorte-de-lista";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import {
  countActiveDeadLetters,
  countRecentPgBossFailures,
  listRecentPgBossFailures,
  type PgBossFailureRow,
} from "@/src/services/ops/dlq/pgboss-queues";
import { findRetainedDeadLetterErrors } from "@/src/services/ops/dlq/repository";

const log = createLogger("operacoes");

/**
 * Falha de job agrupada por INCIDENTE, não por ocorrência: um circuito aberto
 * por horas vira uma linha, não quinze botões de Replay idênticos.
 *
 * A chave é `(fila, causa)` e o grupo carrega o array de membros, não um
 * predicado para a tela re-derivar: o `n` da linha é `membros.length` e a lista
 * que ela abre é esse array.
 */

export type FalhaAgrupada = {
  /** Chave estável para a tela: fila + causa. */
  id: string;
  fila: string;
  causa: CausaDeFalha;
  rotulo: string;
  proximaEtapa: string;
  /** As linhas EXATAS que este grupo contou. */
  membros: Array<{ id: string; betId: string | null; quando: Date; tentativas: number }>;
  n: number;
  primeira: Date;
  ultima: Date;
  /**
   * O replay alcança este job? Só linha da dead-letter: `replayDeadLetter`
   * procura `WHERE name IN (deadLetters)`, então falha na fila de origem não
   * ganha botão que não encontraria o job.
   */
  replayable: boolean;
  /**
   * O botão pode ser clicado AGORA? Junta a regra do vocabulário com o estado
   * VIVO do circuito: `circuito_aberto` que já fechou volta a ser replayável.
   */
  replayHabilitado: boolean;
  /** Por que está desabilitado, quando está. */
  motivoBloqueio: string | null;
};

/** Providers com circuito aberto neste instante. */
async function providersComCircuitoAberto(): Promise<Set<string>> {
  const rows = await prisma.providerCircuit.findMany({
    where: { state: { not: "CLOSED" } },
    select: { provider: true },
  });
  return new Set(rows.map((r) => r.provider));
}

/**
 * `circuito_aberto` só bloqueia o replay enquanto ESTE circuito estiver mesmo
 * aberto. Bloquear pela causa sozinha deixaria o botão morto horas depois de o
 * provider já ter voltado, e o operador não teria como saber a diferença.
 *
 * Sem provider identificável na mensagem, cai no critério grosso ("algum
 * circuito aberto") — conservador de propósito: melhor desabilitar do que
 * oferecer um clique que falha na hora.
 */
function bloqueioDe(
  causa: CausaDeFalha,
  provider: string | null,
  circuitosAbertos: Set<string>,
): string | null {
  if (replayResolveAgora(causa)) return null;
  if (causa === "circuito_aberto") {
    const aindaAberto = provider != null
      ? circuitosAbertos.has(provider)
      : circuitosAbertos.size > 0;
    if (!aindaAberto) return null;
  }
  return proximaEtapaDaCausa(causa);
}

const DLQ_SUFFIX = ".dlq";

/** A falha da origem só fica na lista depois que a cópia saiu da dead-letter. */
const HANDLED_NEXT_STEP = "Já tratada: a cópia saiu da dead-letter (reenfileirada, descartada ou reprocessada).";

/**
 * O erro que decide a causa. A dead-letter retida guarda no `output` o
 * sentinela "retida para replay manual"; a causa real ficou na auditoria da
 * retenção, com a classe que o handler deu.
 */
async function failureOutputs(rows: readonly PgBossFailureRow[]): Promise<Map<string, unknown>> {
  const retained = await findRetainedDeadLetterErrors(rows
    .filter((row) => row.name.endsWith(DLQ_SUFFIX))
    .map((row) => ({ queue: row.name.slice(0, -DLQ_SUFFIX.length), jobId: row.id })));
  return new Map(rows.map((row) => {
    const audit = retained.get(row.id);
    const output = audit
      ? {
          message: audit.errorMsg,
          ...(audit.dlqClass === "business" ? { businessRefusal: true } : {}),
          ...(audit.waitsFor ? { waitsFor: audit.waitsFor } : {}),
        }
      : row.output;
    return [row.id, output];
  }));
}

async function agruparFalhas(
  linhas: readonly PgBossFailureRow[],
): Promise<FalhaAgrupada[]> {
  if (linhas.length === 0) return [];
  const [circuitosAbertos, outputs] = await Promise.all([providersComCircuitoAberto(), failureOutputs(linhas)]);

  const baldes = new Map<string, FalhaAgrupada>();
  for (const linha of linhas) {
    const output = outputs.get(linha.id);
    const causa = classificaCausa(output);
    const id = `${linha.name}::${causa}`;
    const membro = {
      id: linha.id,
      betId: betIdDoPayload(linha.data),
      quando: linha.completed_on ?? linha.created_on,
      tentativas: Number(linha.retry_count ?? 0),
    };
    const balde = baldes.get(id);
    if (!balde) {
      const replayable = linha.name.endsWith(DLQ_SUFFIX);
      const motivoBloqueio = replayable ? bloqueioDe(causa, providerDoCircuito(output), circuitosAbertos) : null;
      baldes.set(id, {
        id,
        fila: linha.name,
        causa,
        rotulo: causaLabel(causa),
        proximaEtapa: replayable ? proximaEtapaDaCausa(causa) : HANDLED_NEXT_STEP,
        membros: [membro],
        n: 1,
        primeira: membro.quando,
        ultima: membro.quando,
        replayable,
        replayHabilitado: replayable && motivoBloqueio == null,
        motivoBloqueio,
      });
      continue;
    }
    balde.membros.push(membro);
    balde.n = balde.membros.length;
    if (membro.quando < balde.primeira) balde.primeira = membro.quando;
    if (membro.quando > balde.ultima) balde.ultima = membro.quando;
  }

  // Incidente mais recente primeiro; o `n` desempata, porque quinze falhas da
  // mesma causa pesam mais que uma.
  return [...baldes.values()].sort((a, b) => b.ultima.getTime() - a.ultima.getTime() || b.n - a.n);
}

export type FalhasDeJob = {
  /** false = o pg-boss não pôde ser lido; lista vazia não significa zero falhas. */
  disponivel: boolean;
  /** Universo (retidas de qualquer idade e histórico da janela), não o tamanho da página agrupada. */
  total: number;
  /**
   * Dead-letters ainda na fila, de qualquer idade: o que falta tratar. O
   * histórico da janela não decide o veredito, senão uma falha já reprocessada
   * deixaria o Monitoramento em atenção por dias.
   */
  retidas: number;
  grupos: FalhaAgrupada[];
};

/**
 * Dead-letters retidas e falhas dos últimos `FALHAS_DE_JOB_JANELA_DIAS` dias,
 * agrupadas por incidente.
 */
export async function getJobFailures(now: Date = new Date()): Promise<FalhasDeJob> {
  try {
    const since = new Date(now.getTime() - FALHAS_DE_JOB_JANELA_DIAS * 86_400_000);
    const [linhas, total, retidas] = await Promise.all([
      listRecentPgBossFailures(since, FALHAS_DE_JOB_LIMITE),
      countRecentPgBossFailures(since),
      countActiveDeadLetters(),
    ]);
    return { disponivel: true, total, retidas, grupos: await agruparFalhas(linhas) };
  } catch (err) {
    log.error({ mod: "operacoes-falhas", err }, "falha ao ler dead-letters recentes (pgboss)");
    return { disponivel: false, total: 0, retidas: 0, grupos: [] };
  }
}
