import { mentionsLiveEntry, persistedLiveScoreAtTipText } from "@/src/domain/live-score-at-tip";
import { toNumber } from "@/src/domain/money";
import { judgeKickoffWindow } from "@/src/domain/settlement/eligibility";
import { isScoreResolvableMarket } from "@/src/domain/settlement/markets";
import { ticketForScore } from "@/src/domain/settlement/ticket-resolution";
import type { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";
import { flashscoreSettlesSportId, flashscoreSportId } from "@/src/providers/flashscore/sports";
import { scoreResolvableMercadoWhere } from "../score-resolvable-query";

/**
 * Quem o IA-Judge avalia: apostas pendentes que o placar do FlashScore não
 * resolve sozinho (mercado fora do placar, ou esporte que ele não liquida) ou
 * que o FlashScore não fechou, fora dos cooldowns por aposta e da pausa de cota.
 */

export const BATCH_SIZE = 20;
const SCAN_PAGE_SIZE = BATCH_SIZE * 4;

const HOUR_MS = 3_600_000;

export const FAILURE_COOLDOWN_MS = 24 * HOUR_MS;
/**
 * `resolved: false` não é baixa confiança: no primeiro dia depois do jogo o
 * resultado ainda pode estar saindo, e a aposta volta no mesmo dia.
 */
export const UNRESOLVED_COOLDOWN_MS = 3 * HOUR_MS;
export const QUOTA_COOLDOWN_MS = 6 * HOUR_MS;

/**
 * Espera até a próxima busca de uma aposta que o juiz não resolveu, ou
 * resolveu sem confiança. Cresce com a idade do jogo: o que a web não trouxe
 * no primeiro dia raramente aparece de hora em hora depois, e cada busca gasta
 * a cota do Gemini que a resolução de esporte e o kickoff pela web dividem. A
 * janela de 30 dias do juiz fica como está.
 */
export function retryCooldownMs(kind: "unresolved" | "low_confidence", kickoff: Date, now: Date): number {
  const ageHours = (now.getTime() - kickoff.getTime()) / HOUR_MS;
  const firstDay = kind === "unresolved" ? UNRESOLVED_COOLDOWN_MS : FAILURE_COOLDOWN_MS;
  const step = ageHours < 24 ? firstDay
    : ageHours < 72 ? 12 * HOUR_MS
    : ageHours < 168 ? 24 * HOUR_MS
    : 72 * HOUR_MS;
  return kind === "low_confidence" ? Math.max(FAILURE_COOLDOWN_MS, step) : step;
}

export const QUOTA_KEY = "quota:global";
export const QUOTA_NOTICE_KEY = "quota:global:notified";

/** Texto curto para o operador; recusa duração que não seja hora inteira. */
export function formatCooldownHours(ms: number): string {
  if (!Number.isInteger(ms) || ms <= 0 || ms % HOUR_MS !== 0) {
    throw new Error(`duração de cooldown inválida para exibição: ${ms}`);
  }
  return `${ms / HOUR_MS}h`;
}

export async function isCooldownActive(key: string, now: Date): Promise<boolean> {
  const row = await prisma.iaJudgeCooldown.findUnique({ where: { key } });
  return Boolean(row && row.expiresAt > now);
}

export async function setCooldown(
  key: string,
  ms: number,
  reason: string,
  now = new Date(),
): Promise<void> {
  const expiresAt = new Date(now.getTime() + ms);
  await prisma.iaJudgeCooldown.upsert({
    where: { key },
    create: { key, reason: reason.slice(0, 500), expiresAt },
    update: { reason: reason.slice(0, 500), expiresAt },
  });
}

export function isQuotaReason(reason: string): boolean {
  return /429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(reason);
}

const CANDIDATE_SELECT = {
  id: true, evento: true, esporte: true, competicao: true, mercado: true,
  selecao: true, odds: true, stake: true, data: true, updatedAt: true, legsJson: true,
  liveScoreHome: true, liveScoreAway: true, liveTextAtCapture: true,
  bankroll: { select: { nome: true } },
} as const;

type CandidateRow = Prisma.BetGetPayload<{ select: typeof CANDIDATE_SELECT }>;

export type IaJudgeCandidate = {
  id: string;
  evento: string;
  esporte: string;
  competicao: string;
  mercado: string;
  selecao: string;
  odds: number;
  stake: number;
  data: Date;
  bankrollNome: string;
  updatedAt: Date;
  /** Múltipla ou criar aposta: as pernas gravadas ou lidas do texto, como a liquidação por placar as lê. */
  combinedTicket: boolean;
  /** A aposta foi pega com o jogo em andamento: a legenda dizia ao vivo ou trazia o placar. */
  liveEntry: boolean;
  /** O placar na hora da aposta ("1-0", mandante primeiro), quando a captura o gravou. */
  liveScoreAtEntry: string | null;
};

function toCandidate(row: CandidateRow): IaJudgeCandidate {
  return {
    id: row.id,
    evento: row.evento,
    esporte: row.esporte,
    competicao: row.competicao,
    mercado: row.mercado,
    selecao: row.selecao,
    odds: toNumber(row.odds),
    stake: toNumber(row.stake),
    data: row.data,
    bankrollNome: row.bankroll.nome,
    updatedAt: row.updatedAt,
    // Múltipla registrada à mão sem as pernas ("A vs B | C vs D") também conta:
    // o ticketForScore não a lê, e o placar de um jogo só não a liquida.
    combinedTicket: ticketForScore(row) !== null || row.legsJson != null || row.evento.includes(" | "),
    liveEntry: row.liveTextAtCapture || row.liveScoreHome !== null || row.liveScoreAway !== null
      || [row.mercado, row.selecao].some(mentionsLiveEntry),
    liveScoreAtEntry: persistedLiveScoreAtTipText(row),
  };
}

/** Aposta pendente, confirmada, sem prop persistida e dentro da janela do juiz. */
function candidateWhere(now: Date, skipIds: ReadonlySet<string> = new Set()): Prisma.BetWhereInput {
  const { minKickoff, maxKickoff } = judgeKickoffWindow(now);
  return {
    playerProp: null,
    deletedAt: null,
    sportResolutionStatus: "CONFIRMED",
    status: "PENDING",
    ...(skipIds.size > 0 ? { id: { notIn: [...skipIds] } } : {}),
    kickoffInferido: false,
    data: { lte: maxKickoff, gte: minKickoff },
    judgeSuggestions: { none: { status: "PENDING" } },
  };
}

/** Apostas em cooldown próprio (falha, não resolvida, recusa manual). */
async function betsInCooldown(now: Date): Promise<Set<string>> {
  const betCooldowns = await prisma.iaJudgeCooldown.findMany({
    where: { key: { startsWith: "bet:" }, expiresAt: { gt: now } },
    select: { key: true },
  });
  return new Set(betCooldowns.map((c) => c.key.slice(4)));
}

/**
 * O placar só dispensa o juiz no esporte que o FlashScore liquida: em MMA,
 * boxe, golfe ou F1 a observação fecha sem resultado, e o juiz é o único
 * liquidador automático que sobra.
 */
function scoreSettlesAlone(row: Pick<CandidateRow, "mercado" | "selecao" | "esporte" | "evento">): boolean {
  const sportId = flashscoreSportId(row.esporte);
  return sportId !== null && flashscoreSettlesSportId(sportId) &&
    isScoreResolvableMarket({ mercado: row.mercado, selecao: row.selecao, esporte: row.esporte, evento: row.evento });
}

/**
 * O espelho SQL é deliberadamente mais largo que o domínio. Portanto `take`
 * ANTES da guarda de domínio não é limite de trabalho: é starvation. Avançamos
 * por chave estável até esgotar o pool, que a janela do juiz já limita; a
 * ordem do lote fica com `byLastAttempt`.
 */
async function scanCandidatePool(params: {
  common: Prisma.BetWhereInput;
  scoreMirror: boolean;
}): Promise<IaJudgeCandidate[]> {
  const out: IaJudgeCandidate[] = [];
  let after: { data: Date; id: string } | null = null;
  for (;;) {
    const scoreWhere = scoreResolvableMercadoWhere();
    const page: CandidateRow[] = await prisma.bet.findMany({
      where: {
        ...params.common,
        AND: [
          params.scoreMirror ? scoreWhere : { NOT: scoreWhere },
          ...(after
            ? [{
              OR: [
                { data: { gt: after.data } },
                { data: after.data, id: { gt: after.id } },
              ],
            }]
            : []),
        ],
      },
      orderBy: [{ data: "asc" }, { id: "asc" }],
      take: SCAN_PAGE_SIZE,
      select: CANDIDATE_SELECT,
    });
    if (page.length === 0) break;
    const last: CandidateRow = page.at(-1)!;
    after = { data: last.data, id: last.id };
    for (const row of page) {
      if (!scoreSettlesAlone(row)) out.push(toCandidate(row));
    }
    if (page.length < SCAN_PAGE_SIZE) break;
  }
  return out;
}

/**
 * Ordem da fila: o que nunca foi julgado (ou cujo cooldown já foi purgado),
 * depois a tentativa mais antiga, e só então o kickoff. Assim a aposta que a
 * IA não resolve vai para o fim a cada tentativa e não ocupa todos os lotes.
 */
async function byLastAttempt(bets: IaJudgeCandidate[]): Promise<IaJudgeCandidate[]> {
  if (bets.length === 0) return bets;
  const attempts = await prisma.iaJudgeCooldown.findMany({
    where: { key: { in: bets.map((bet) => `bet:${bet.id}`) } },
    select: { key: true, updatedAt: true },
  });
  const lastAttempt = new Map(attempts.map((row) => [row.key.slice(4), row.updatedAt.getTime()]));
  const attemptOf = (bet: IaJudgeCandidate) => lastAttempt.get(bet.id) ?? Number.NEGATIVE_INFINITY;
  return [...bets].sort((a, b) =>
    (attemptOf(a) === attemptOf(b) ? 0 : attemptOf(a) - attemptOf(b)) ||
    a.data.getTime() - b.data.getTime() ||
    a.id.localeCompare(b.id));
}

export async function findIaJudgeCandidates(now = new Date()): Promise<IaJudgeCandidate[]> {
  if (await isCooldownActive(QUOTA_KEY, now)) return [];
  const common = candidateWhere(now, await betsInCooldown(now));
  const [foraDoPlacar, limbo] = await Promise.all([
    scanCandidatePool({ common, scoreMirror: false }),
    scanCandidatePool({ common, scoreMirror: true }),
  ]);
  return (await byLastAttempt([...foraDoPlacar, ...limbo])).slice(0, BATCH_SIZE);
}

/** A listagem é só descoberta: o prompt nasce do estado atual da aposta. */
export async function loadCurrentCandidate(
  id: string,
  now: Date,
): Promise<IaJudgeCandidate | null> {
  const bet = await prisma.bet.findFirst({
    where: { id, ...candidateWhere(now) },
    select: CANDIDATE_SELECT,
  });
  if (!bet) return null;
  return toCandidate(bet);
}

/**
 * Apostas paradas pós-FlashScore: jogo encerrado (janela de kickoff) ainda
 * PENDING, cujo FlashScore não finalizou (sem cobertura ou falha de
 * resultado). O IA-Judge atua como fallback.
 */
export async function findStalledSettlementCandidates(now = new Date()): Promise<IaJudgeCandidate[]> {
  if (await isCooldownActive(QUOTA_KEY, now)) return [];
  const stalledBets = await prisma.bet.findMany({
    where: {
      ...candidateWhere(now, await betsInCooldown(now)),
      OR: [
        { result: null },
        { result: { is: { resultFinal: false } } },
      ],
    },
    select: CANDIDATE_SELECT,
  });
  return (await byLastAttempt(stalledBets.map(toCandidate))).slice(0, BATCH_SIZE);
}
