import { PROVISIONAL_KICKOFF_DAY_MS } from "@/src/domain/enrich-cadence";
import { Prisma } from "@/src/generated/prisma/client";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import { lockActiveEnrichBet } from "./write-guard";
import type { BridgeMatchCandidate } from "@/src/providers/bridgeodds/scoring";

/**
 * Persistência dos casos de matching: dedupe de candidatos,
 * registro do caso (OPEN/LLM_APPLIED) e fechamento quando o AUTO/manual
 * resolve. A fila humana em /operacoes consome estes registros.
 */

const log = createLogger("training-cases");

export function dedupeCandidates(list: BridgeMatchCandidate[]): BridgeMatchCandidate[] {
  const byId = new Map<number, BridgeMatchCandidate>();
  for (const c of list) {
    const existing = byId.get(c.match.match_id);
    if (!existing || c.score > existing.score) byId.set(c.match.match_id, c);
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, 10);
}

/**
 * Gap mínimo entre 1º e 2º para AUTO aplicar sozinho. Dois jogos com score
 * quase empatado (≥ piso) é cara-ou-coroa — cai para LLM / fila humana.
 */
export const AUTO_MATCH_MIN_GAP = 0.1;

/** true quando os dois melhores candidatos DISTINTOS estão empatados (< gap). */
export function autoMatchAmbiguous(candidates: BridgeMatchCandidate[]): boolean {
  const distinct = dedupeCandidates(candidates);
  const first = distinct[0];
  const second = distinct[1];
  if (!first || !second) return false;
  return first.score - second.score < AUTO_MATCH_MIN_GAP;
}

type CaseStatus = "OPEN" | "LLM_APPLIED" | "AUTO_APPLIED";

function matchingDiagnostic(reason: string): Prisma.InputJsonObject {
  return { source: "matching", reason: reason.slice(0, 240) };
}

/**
 * Motivos em que 0 candidatos NÃO são trabalho humano: a busca não aconteceu
 * ou o provider estava sem cota. Abrir a caixa "Resolver identidade" com
 * lista vazia mistura isso com zona cinzenta de verdade.
 */
export function isWaitingProviderTrainingReason(reason: string | undefined): boolean {
  if (!reason) return false;
  if (reason.startsWith("past_event:")) return false;
  return /budget|truncated|deferred_alternatives|llm_indisponivel|sem_match_nos_tiers|feed_unavailable/i
    .test(reason);
}

/**
 * Sem candidato, a busca segue depois do jogo (a BridgeOdds ainda lista o
 * evento): o caso só vira trabalho do dono se ela continuar sem achar.
 */
export const NO_CANDIDATE_OWNER_DELAY_MS = 6 * 3_600_000;

const NO_CANDIDATES: Prisma.TrainingCaseWhereInput = {
  OR: [{ candidatesJson: { equals: Prisma.AnyNull } }, { candidatesJson: { equals: [] } }],
};

/**
 * Caso aberto que já é trabalho do dono. Enquanto o revival ainda pode casar
 * sozinho (a Pinnacle costuma listar o jogo horas depois da tip), mostrar o
 * caso só pede atenção sem nada a fazer: com candidatos, ele espera o
 * início do jogo, quando as tentativas anteriores a ele já falharam; sem
 * candidatos, mais `NO_CANDIDATE_OWNER_DELAY_MS`; com kickoff provisório, o
 * fim do dia, quando a busca desiste. O caso continua OPEN e o revival
 * continua tentando; isto só decide quando ele aparece.
 */
export function trainingCaseDueForOwnerWhere(now: Date): Prisma.TrainingCaseWhereInput {
  const until = (delayMs: number) => new Date(now.getTime() - delayMs);
  return {
    status: "OPEN",
    OR: [
      { bet: { is: { deletedAt: null, kickoffInferido: true, data: { lte: until(PROVISIONAL_KICKOFF_DAY_MS) } } } },
      {
        NOT: NO_CANDIDATES,
        bet: { is: { deletedAt: null, kickoffInferido: false, data: { lte: now } } },
      },
      {
        AND: [NO_CANDIDATES],
        bet: { is: { deletedAt: null, kickoffInferido: false, data: { lte: until(NO_CANDIDATE_OWNER_DELAY_MS) } } },
      },
    ],
  };
}

function isLlmJudgeVerdict(verdict: unknown): boolean {
  return Boolean(verdict && typeof verdict === "object" && "candidateIndex" in verdict);
}

type TrainingBet = { id: string; evento: string; esporte: string; pais: string; competicao: string };

/** A busca externa só grava trabalho para a aposta e a identidade que ainda valem. */
async function withCurrentTrainingBet(bet: TrainingBet, write: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  await runSerializableTransaction("training.record", async (tx) => {
    await lockActiveEnrichBet(tx, bet.id);
    const current = await tx.bet.findUniqueOrThrow({
      where: { id: bet.id },
      select: { evento: true, esporte: true, pais: true, competicao: true, sharp: { select: { identityStatus: true } } },
    });
    if ((["evento", "esporte", "pais", "competicao"] as const).some((field) => current[field] !== bet[field])) return;
    if (current.sharp && ["MANUAL", "MATCHED", "UNSUPPORTED"].includes(current.sharp.identityStatus)) return;
    await write(tx);
  });
}

export async function recordTrainingCase(
  bet: TrainingBet,
  candidates: BridgeMatchCandidate[],
  status: CaseStatus,
  verdict: unknown,
  failureReason?: string,
): Promise<void> {
  if (
    status === "OPEN" &&
    candidates.length === 0 &&
    !isLlmJudgeVerdict(verdict) &&
    isWaitingProviderTrainingReason(failureReason)
  ) {
    return;
  }

  const candidatesJson = candidates.map((c) => ({
    matchId: c.match.match_id,
    home: c.match.home,
    away: c.match.away,
    league: c.match.league,
    matchDate: c.match.match_date,
    score: Math.round(c.score * 50),
    swapped: c.swapped,
  }));
  await withCurrentTrainingBet(bet, async (tx) => {
    const aberto = await tx.trainingCase.findFirst({
      where: { betId: bet.id, status: "OPEN" },
      select: { id: true, candidatesJson: true, autoScore: true },
    });
    // Tentativa que volta sem candidato (a Bridge oscila) não apaga os que o caso
    // aberto já tinha: são eles que o dono escolhe, e sem eles o caso sairia de
    // Vincular até o prazo do caso sem candidato.
    const keepCandidates = status === "OPEN" && candidatesJson.length === 0 &&
      Array.isArray(aberto?.candidatesJson) && aberto.candidatesJson.length > 0;
    const data = {
      status,
      candidatesJson: keepCandidates ? (aberto?.candidatesJson as Prisma.InputJsonValue) : candidatesJson,
      autoScore: keepCandidates ? (aberto?.autoScore ?? 0) : (candidatesJson[0]?.score ?? 0),
      llmVerdictJson: verdict === null
        ? failureReason
          ? matchingDiagnostic(failureReason)
          : undefined
        : (verdict as object),
      resolution: status === "LLM_APPLIED" ? ("LLM" as const) : undefined,
      resolvedAt: status === "OPEN" ? null : new Date(),
    };
    if (aberto) {
      // O Vincular pode ter fechado o caso desde a leitura; a busca antiga perde a vez.
      await tx.trainingCase.updateMany({ where: { id: aberto.id, status: "OPEN" }, data });
      return;
    }
    await tx.trainingCase.create({
      data: {
        betId: bet.id,
        evento: bet.evento,
        esporte: bet.esporte,
        pais: bet.pais,
        competicao: bet.competicao,
        ...data,
      },
    });
  });
}

/** Acrescenta o motivo terminal sem apagar candidatos já encontrados. */
export async function recordTrainingFailure(
  bet: TrainingBet,
  reason: string,
): Promise<void> {
  await withCurrentTrainingBet(bet, async (tx) => {
    const aberto = await tx.trainingCase.findFirst({
      where: { betId: bet.id, status: "OPEN" },
      select: { id: true, llmVerdictJson: true },
    });
    if (!aberto) {
      if (isWaitingProviderTrainingReason(reason)) return;
      await tx.trainingCase.create({ data: {
        betId: bet.id, evento: bet.evento, esporte: bet.esporte, pais: bet.pais, competicao: bet.competicao,
        status: "OPEN", candidatesJson: [], autoScore: 0, llmVerdictJson: matchingDiagnostic(reason),
      } });
      return;
    }
    const diagnostic = aberto.llmVerdictJson as { source?: unknown } | null;
    // Um veredito real da LLM já explica a rejeição. A terminalização posterior
    // não pode apagá-lo; apenas diagnósticos da própria busca são atualizados.
    if (aberto.llmVerdictJson && diagnostic?.source !== "matching") return;
    await tx.trainingCase.updateMany({
      where: { id: aberto.id, status: "OPEN" },
      data: { llmVerdictJson: matchingDiagnostic(reason) },
    });
  });
}

export async function closeOpenTrainingCase(
  betId: string,
  status: "AUTO_APPLIED" | "RESOLVED_MANUAL",
): Promise<void> {
  await prisma.trainingCase.updateMany({
    where: { betId, status: "OPEN" },
    data: {
      status,
      resolution: status === "AUTO_APPLIED" ? "AUTO" : "MANUAL",
      resolvedAt: new Date(),
    },
  });
}

/** Fecha caso OPEN quando a aposta foi soft-deleted (👎 / remoção) ou editada. */
export async function closeOpenTrainingCaseForDeletedBetTx(
  tx: Prisma.TransactionClient,
  betId: string,
  now = new Date(),
): Promise<number> {
  const { count } = await tx.trainingCase.updateMany({
    where: { betId, status: "OPEN" },
    data: { status: "EXPIRED", resolvedAt: now },
  });
  return count;
}

/**
 * Varre casos OPEN órfãos (aposta com deletedAt) — rede de segurança p/
 * histórico e race entre enrich e soft-delete. Roda no job diário
 * `training.close_stale_cases`.
 */
export async function dismissOrphanTrainingCases(params?: {
  actor?: string;
  now?: Date;
}): Promise<number> {
  const now = params?.now ?? new Date();
  const actor = params?.actor ?? "system";
  const orphans = await prisma.trainingCase.findMany({
    where: {
      status: "OPEN",
      betId: { not: null },
      bet: { is: { deletedAt: { not: null } } },
    },
    select: { id: true, betId: true },
  });
  if (orphans.length === 0) return 0;

  let dismissed = 0;
  for (const caso of orphans) {
    const { count } = await prisma.trainingCase.updateMany({
      where: { id: caso.id, status: "OPEN", bet: { is: { deletedAt: { not: null } } } },
      data: { status: "EXPIRED", resolvedAt: now },
    });
    if (!count) continue;
    dismissed += count;
    await prisma.auditEvent.create({
      data: {
        actor,
        action: "training_case.bet_deleted_dismiss",
        resource: "training_case",
        resourceId: caso.id,
        details: { betId: caso.betId, reason: "bet_soft_deleted" },
      },
    });
    log.info({ caseId: caso.id, betId: caso.betId }, "caso de treino fechado — aposta removida");
  }
  return dismissed;
}

/** Janela após o kickoff para considerar um caso OPEN como EXPIRED. */
const EXPIRE_AFTER_KICKOFF_MS = 3 * 86_400_000;

/**
 * Expira casos OPEN cujo jogo já passou (kickoff < agora − 3d): o revival só
 * caça até +72h do kickoff, então depois disso um caso aberto não se resolve
 * mais sozinho e só polui a fila humana. Roda no job diário
 * `training.close_stale_cases`; devolve quantos expirou.
 */
export async function expireStaleTrainingCases(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - EXPIRE_AFTER_KICKOFF_MS);
  const { count } = await prisma.trainingCase.updateMany({
    where: { status: "OPEN", bet: { is: { data: { lt: cutoff } } } },
    data: { status: "EXPIRED", resolvedAt: now },
  });
  return count;
}
