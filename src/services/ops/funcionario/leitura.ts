import { canonicalSha256 } from "@/src/domain/canonical-json";
import { spDayKey, spStartOfTodayUtc } from "@/src/domain/dates";
import { ACTIVE_OPERATIONAL_ACTION_STATUSES } from "@/src/domain/operational-action-status";
import { sportPendingMessage } from "@/src/domain/sport-pending";
import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";
import {
  extractFlashscoreJudgeEvidence,
  flashscoreBetSides,
  flashscoreJudgeFacts,
} from "@/src/services/settlement/ia-judge/flashscore-evidence";
import { getPendingIaJudgeSuggestionsPage } from "@/src/services/settlement/ia-judge/suggestions";
import { FUNCIONARIO_WRITE_ACTIONS, readWriteBudget, type WriteBudget } from "./escrita";

/**
 * O que o funcionário de IA lê (`ops-funcionario`): as pendências que caem
 * para o dono, a ficha de uma aposta e o resumo do dia. Só leitura.
 *
 * As pendências são as da caixa de Operações (a reconciliação decide o que é
 * trabalho do dono) e as filas do painel (sugestões do IA-Judge, perguntas na
 * DM), com o estado atual de cada aposta: o que já foi resolvido desde a
 * última reconciliação não aparece.
 */

const PENDING_LIMIT = 50;
const CAPTION_EXCERPT = 280;

type Candidate = { indice: number; hash: string } & Record<string, unknown>;

/** Cada candidato com o índice e o hash que o `vincular` exige: a prova de qual jogo o agente leu. */
function candidatesOf(json: unknown): Candidate[] {
  return Array.isArray(json)
    ? json.flatMap((item, indice) => item && typeof item === "object"
      ? [{ ...(item as Record<string, unknown>), indice, hash: canonicalSha256(item) }]
      : [])
    : [];
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Os candidatos de esporte gravados pelo resolvedor, sem o resto da evidência. */
function sportCandidatesOf(evidence: unknown) {
  const candidates = jsonRecord(evidence)?.candidates;
  return Array.isArray(candidates)
    ? candidates.flatMap((item) => {
        const c = jsonRecord(item);
        return c ? [{ sport: c.sport, confidence: c.confidence, source: c.source, provider: c.provider ?? null, strategy: c.strategy ?? null }] : [];
      })
    : [];
}

async function activeActionIds(source: string): Promise<Array<{ resourceId: string; description: string }>> {
  const rows = await prisma.operationalAction.findMany({
    where: {
      fingerprint: { startsWith: `${source}:` },
      status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] },
      resourceId: { not: null },
      NOT: { resourceId: "overflow" },
    },
    orderBy: [{ priority: "desc" }, { openedAt: "asc" }],
    take: PENDING_LIMIT,
    select: { resourceId: true, description: true },
  });
  return rows.flatMap((row) => row.resourceId ? [{ resourceId: row.resourceId, description: row.description }] : []);
}

async function vincularPendentes() {
  const ids = (await activeActionIds("training")).map((row) => row.resourceId);
  const cases = await prisma.trainingCase.findMany({
    where: { id: { in: ids }, status: "OPEN" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, evento: true, esporte: true, pais: true, competicao: true, candidatesJson: true, createdAt: true,
      bet: { select: { id: true, evento: true, mercado: true, selecao: true, data: true, kickoffInferido: true, deletedAt: true, bankroll: { select: { nome: true } } } },
    },
  });
  return cases.filter((c) => !c.bet?.deletedAt).map((c) => {
    const candidatos = candidatesOf(c.candidatesJson);
    return {
      caseId: c.id,
      betId: c.bet?.id ?? null,
      tipster: c.bet?.bankroll.nome ?? null,
      evento: c.evento,
      esporte: c.esporte,
      pais: c.pais,
      competicao: c.competicao,
      mercado: c.bet?.mercado ?? null,
      selecao: c.bet?.selecao ?? null,
      inicio: c.bet?.data.toISOString() ?? null,
      horarioProvisorio: c.bet?.kickoffInferido ?? null,
      candidatos,
      precisa: candidatos.length > 0
        ? "Escolher o candidato que é o jogo da aposta (vincular, com o índice, o hash dele e a evidência) ou adiar (ignorar_caso) se nenhum servir."
        : "Sem candidato: só o dono resolve, corrigindo o nome do evento na ficha da aposta.",
    };
  });
}

async function esportesPendentes() {
  const ids = (await activeActionIds("sport-resolution")).map((row) => row.resourceId);
  const bets = await prisma.bet.findMany({
    where: { id: { in: ids }, deletedAt: null, sportResolutionStatus: { in: ["PENDING", "CONFLICT"] } },
    orderBy: [{ data: "asc" }, { id: "asc" }],
    select: {
      id: true, evento: true, esporte: true, mercado: true, selecao: true, competicao: true, pais: true, data: true,
      kickoffInferido: true, sportResolutionStatus: true, sportEvidence: true, bankroll: { select: { nome: true } },
    },
  });
  return bets.map((bet) => ({
    betId: bet.id,
    tipster: bet.bankroll.nome,
    evento: bet.evento,
    esporteGravado: bet.esporte,
    status: bet.sportResolutionStatus,
    mercado: bet.mercado,
    selecao: bet.selecao,
    competicao: bet.competicao,
    pais: bet.pais,
    inicio: bet.data.toISOString(),
    horarioProvisorio: bet.kickoffInferido,
    situacao: sportPendingMessage(bet.sportEvidence),
    candidatos: sportCandidatesOf(bet.sportEvidence),
    precisa: "Confirmar o esporte (confirmar_esporte) com a fonte que o prova, ou deixar para o dono se não houver prova.",
  }));
}

async function liquidacoesPendentes(now: Date) {
  const actions = await activeActionIds("settlement.parado");
  const byBet = new Map(actions.map((row) => [row.resourceId, row.description]));
  const bets = await prisma.bet.findMany({
    where: { id: { in: [...byBet.keys()] }, deletedAt: null, status: "PENDING" },
    orderBy: [{ data: "asc" }, { id: "asc" }],
    select: {
      id: true, evento: true, esporte: true, pais: true, competicao: true, mercado: true, selecao: true, odds: true,
      data: true, sportResolutionStatus: true, bankroll: { select: { nome: true } },
      result: { select: { resultProvider: true, resultSnapshot: true } },
    },
  });
  return bets.map((bet) => {
    const snapshot = bet.result?.resultProvider === "flashscore" ? bet.result.resultSnapshot : null;
    return {
      betId: bet.id,
      tipster: bet.bankroll.nome,
      evento: bet.evento,
      esporte: bet.esporte,
      esporteConfirmado: bet.sportResolutionStatus === "CONFIRMED",
      pais: bet.pais,
      competicao: bet.competicao,
      mercado: bet.mercado,
      selecao: bet.selecao,
      odds: Number(bet.odds),
      inicio: bet.data.toISOString(),
      horasDesdeOInicio: Math.floor((now.getTime() - bet.data.getTime()) / 3_600_000),
      situacao: byBet.get(bet.id) ?? null,
      fatosDoFlashscore: snapshot ? flashscoreJudgeFacts(snapshot) : [],
      precisa: "Provar o resultado (placar ou estatística, com a fonte) e liquidar pelo liquidar; sem prova, deixar para o dono.",
    };
  });
}

async function sugestoesDoIaJudge() {
  const { items } = await getPendingIaJudgeSuggestionsPage();
  return items.map((s) => ({
    suggestionId: s.id,
    betId: s.betId,
    tipster: s.bet.bankroll.nome,
    evento: s.bet.evento,
    esporte: s.bet.esporte,
    competicao: s.bet.competicao,
    mercado: s.bet.mercado,
    selecao: s.bet.selecao,
    odds: Number(s.bet.odds),
    inicio: s.bet.data.toISOString(),
    sugere: s.suggestedStatus,
    valorEncontrado: s.valueFound,
    confianca: s.confidence,
    motivo: s.reason,
    fonte: s.sourceUrl,
    precisa: "Conferir o resultado na fonte e liquidar pelo liquidar (com a evidência do que viu); se a sugestão estiver errada, liquidar com o resultado provado ou deixar para o dono.",
  }));
}

/** Recusas de captura que o bot perguntou ao dono na DM: só ele responde. */
async function perguntasNaDm(now: Date) {
  const drafts = await prisma.telegramDmDraft.findMany({
    where: { captureFix: { not: Prisma.DbNull }, expiresAt: { gt: now } },
    orderBy: { postDate: "asc" },
    take: PENDING_LIMIT,
    select: { captureFix: true, postDate: true, expiresAt: true },
  });
  return drafts.flatMap((draft) => {
    const fix = jsonRecord(draft.captureFix);
    if (!fix) return [];
    return [{
      tipster: typeof fix.bankrollNome === "string" ? fix.bankrollNome : null,
      motivo: typeof fix.reason === "string" ? fix.reason : null,
      dado: typeof fix.field === "string" ? fix.field : null,
      postadoEm: draft.postDate.toISOString(),
      expiraEm: draft.expiresAt.toISOString(),
      trecho: typeof fix.caption === "string" ? fix.caption.slice(0, CAPTION_EXCERPT) : "",
      precisa: "Só o dono responde, na DM do bot: o agente não conserta captura.",
    }];
  });
}

export type Pendencias = Awaited<ReturnType<typeof listPendencias>>;

export async function listPendencias(now = new Date()) {
  const [vincular, esportes, liquidar, sugestoesIaJudge, dm] = await Promise.all([
    vincularPendentes(),
    esportesPendentes(),
    liquidacoesPendentes(now),
    sugestoesDoIaJudge(),
    perguntasNaDm(now),
  ]);
  return {
    geradoEm: now.toISOString(),
    totais: {
      vincular: vincular.length,
      esportes: esportes.length,
      liquidar: liquidar.length,
      sugestoesIaJudge: sugestoesIaJudge.length,
      perguntasNaDm: dm.length,
    },
    vincular,
    esportes,
    liquidar,
    sugestoesIaJudge,
    perguntasNaDm: dm,
  };
}

/**
 * Tudo o que o agente precisa para decidir sobre uma aposta: o que foi
 * capturado (a legenda some em 30 dias), esporte, identidade, os candidatos
 * do Vincular, o que o FlashScore viu e a sugestão do IA-Judge.
 */
export async function readBetFicha(betId: string) {
  const bet = await prisma.bet.findUnique({
    where: { id: betId },
    select: {
      id: true, evento: true, esporte: true, sportResolutionStatus: true, sportConfidence: true, sportSource: true,
      sportEvidence: true, pais: true, competicao: true, mercado: true, selecao: true, odds: true, stake: true,
      status: true, lucro: true, data: true, kickoffInferido: true, registradoEm: true, sourcePostedAt: true,
      deletedAt: true, liveScoreHome: true, liveScoreAway: true, legsJson: true, manualSettlementVersion: true,
      bankroll: { select: { nome: true } },
      captureEvidence: { select: { caption: true, parser: true, parsedJson: true } },
      sharp: { select: { identityStatus: true, provider: true, providerMatchId: true, confidence: true, identityResolvedAt: true } },
      result: { select: { resultProvider: true, resultSnapshot: true, resultMatchId: true, resultFinal: true, resultCheckedAt: true, scoreHome: true, scoreAway: true } },
      trainingCases: { where: { status: "OPEN" }, select: { id: true, candidatesJson: true }, take: 1 },
      judgeSuggestions: {
        where: { status: "PENDING" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, suggestedStatus: true, valueFound: true, confidence: true, reason: true, sourceUrl: true, createdAt: true },
      },
    },
  });
  if (!bet) return null;
  const snapshot = bet.result?.resultProvider === "flashscore" ? bet.result.resultSnapshot : null;
  const openCase = bet.trainingCases[0] ?? null;
  const suggestion = bet.judgeSuggestions[0] ?? null;
  return {
    aposta: {
      id: bet.id,
      tipster: bet.bankroll.nome,
      evento: bet.evento,
      pais: bet.pais,
      competicao: bet.competicao,
      mercado: bet.mercado,
      selecao: bet.selecao,
      odds: Number(bet.odds),
      stake: Number(bet.stake),
      status: bet.status,
      lucro: Number(bet.lucro),
      inicio: bet.data.toISOString(),
      horarioProvisorio: bet.kickoffInferido,
      postadoEm: bet.sourcePostedAt?.toISOString() ?? null,
      registradoEm: bet.registradoEm.toISOString(),
      removida: bet.deletedAt !== null,
      placarNaEntradaAoVivo: bet.liveScoreHome !== null && bet.liveScoreAway !== null
        ? { casa: bet.liveScoreHome, fora: bet.liveScoreAway }
        : null,
      pernas: bet.legsJson,
    },
    post: bet.captureEvidence
      ? { legenda: bet.captureEvidence.caption, leitor: bet.captureEvidence.parser, lido: bet.captureEvidence.parsedJson }
      : null,
    esporte: {
      esporte: bet.esporte,
      status: bet.sportResolutionStatus,
      confianca: bet.sportConfidence,
      fonte: bet.sportSource,
      situacao: sportPendingMessage(bet.sportEvidence),
      candidatos: sportCandidatesOf(bet.sportEvidence),
    },
    identidade: bet.sharp
      ? {
          status: bet.sharp.identityStatus,
          fornecedor: bet.sharp.provider,
          jogo: bet.sharp.providerMatchId,
          confianca: bet.sharp.confidence,
          resolvidaEm: bet.sharp.identityResolvedAt?.toISOString() ?? null,
        }
      : null,
    vincular: openCase ? { caseId: openCase.id, candidatos: candidatesOf(openCase.candidatesJson) } : null,
    flashscore: snapshot
      ? {
          jogo: bet.result?.resultMatchId ?? null,
          final: bet.result?.resultFinal ?? false,
          conferidoEm: bet.result?.resultCheckedAt?.toISOString() ?? null,
          placar: bet.result?.scoreHome !== null && bet.result?.scoreAway !== null
            ? { primeiroTimeDaAposta: bet.result?.scoreHome, segundoTimeDaAposta: bet.result?.scoreAway }
            : null,
          lados: flashscoreBetSides(snapshot),
          fatos: flashscoreJudgeFacts(snapshot),
          evidencia: extractFlashscoreJudgeEvidence(snapshot),
        }
      : null,
    sugestaoIaJudge: suggestion
      ? {
          suggestionId: suggestion.id,
          sugere: suggestion.suggestedStatus,
          valorEncontrado: suggestion.valueFound,
          confianca: suggestion.confidence,
          motivo: suggestion.reason,
          fonte: suggestion.sourceUrl,
          criadaEm: suggestion.createdAt.toISOString(),
        }
      : null,
  };
}

const ACTION_LABELS: Record<(typeof FUNCIONARIO_WRITE_ACTIONS)[number], string> = {
  "training_case.resolve": "vinculados",
  "training_case.defer": "adiados",
  "bet.sport_resolve.operator": "esportes",
  "bet.settle_delegated": "liquidadas",
};

/** O que o executor fez hoje (dia de São Paulo), o teto que resta ao dono e o que ainda está pendente. */
export async function readDaySummary(executor: string, now = new Date()): Promise<{
  dia: string;
  executor: string;
  feitas: Record<string, number>;
  escritas: Array<{ acao: string; recurso: string | null; em: string; resultado: string }>;
  teto: WriteBudget;
  pendencias: Pendencias["totais"];
}> {
  const since = spStartOfTodayUtc(now);
  const [rows, teto, pendencias] = await Promise.all([
    prisma.auditEvent.findMany({
      where: { actor: executor, action: { in: [...FUNCIONARIO_WRITE_ACTIONS] }, createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      select: { action: true, resourceId: true, createdAt: true, outcome: true },
    }),
    readWriteBudget(executor, now),
    listPendencias(now),
  ]);
  const feitas = Object.fromEntries(Object.values(ACTION_LABELS).map((label) => [label, 0]));
  for (const row of rows) {
    const label = ACTION_LABELS[row.action as keyof typeof ACTION_LABELS];
    if (label) feitas[label] = (feitas[label] ?? 0) + 1;
  }
  return {
    dia: spDayKey(now),
    executor,
    feitas,
    escritas: rows.map((row) => ({ acao: row.action, recurso: row.resourceId, em: row.createdAt.toISOString(), resultado: row.outcome })),
    teto,
    pendencias: pendencias.totais,
  };
}
