import { spRelative } from "@/src/domain/dates";
import { ACTIVE_OPERATIONAL_ACTION_STATUSES } from "@/src/domain/operational-action-status";
import { hasNonScoreStatQualifier } from "@/src/domain/settlement/markets";
import { sportPendingMessage } from "@/src/domain/sport-pending";
import { SPORT_RESOLUTION_BACKOFF_MS } from "@/src/domain/sport-resolution-retry";
import { BetStatus, OperationalRisk } from "@/src/generated/prisma/client";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { closeGcActions } from "@/src/services/ops/action-resource-gc";
import { SCHEDULED_TICK_DISCARD_ACTION } from "@/src/services/ops/dlq/repository";
import { listDeadLetters, type DeadLetterRow } from "@/src/services/ops/dlq/replay";
import { describeTelegramPost } from "@/src/services/ops/dlq/telegram-post";
import { deadLetterGuidance } from "@/src/domain/dlq-classification";
import {
  closeOperationalAction,
  reconcileOperationalActionSource,
  reportOperationalActions,
  type ReportOperationalActionInput,
} from "@/src/services/ops/operational-actions";
import {
  FLASHSCORE_UNCOVERED_OUTCOMES,
  listPostponedWaitingBetIds,
} from "@/src/services/settlement/flashscore/observation-store";
import { pedidoDeParEstatistico } from "@/src/services/settlement/flashscore/statistics";
import { trainingCaseDueForOwnerWhere } from "@/src/services/sharp/enrich/training-cases";

/**
 * Coletores periódicos que abastecem a caixa de ações a partir do estado do
 * sistema. O núcleo da caixa (abrir, assumir, encerrar, reconciliar uma fonte)
 * vive em `operational-actions.ts`; aqui mora a leitura de cada fonte.
 */

const log = createLogger("mapped-channel-actions");

const RECONCILE_SOURCE_LIMIT = 200;
/** Os resultados são buscados a cada 10 min: 6h depois do kickoff não é atraso, é aposta parada. */
const SETTLEMENT_ATRASO_MS = 6 * 60 * 60_000;
const WATCHDOG_WINDOW_MS = 24 * 60 * 60_000;

type SourceAction = Omit<ReportOperationalActionInput, "source" | "key" | "area" | "incrementOccurrence">;

type ActionSource<Row> = {
  source: string;
  area: string;
  key: (row: Row) => string;
  action: (row: Row) => SourceAction;
  /** Ação única que substitui a reconciliação quando a leitura foi truncada. */
  overflow: { actionType: string; title: string; what: string; resource: string; resourceId: string };
};

/**
 * Reporta as linhas lidas (até o limite) e reconcilia a fonte. Um snapshot
 * truncado não prova que as ações fora do lote ficaram obsoletas: nesse caso
 * nada é auto-resolvido e a truncagem vira uma ação própria.
 */
async function syncActionSource<Row>(
  definition: ActionSource<Row>,
  rowsReadWithOneExtra: Row[],
  now: Date,
): Promise<number> {
  const truncated = rowsReadWithOneExtra.length > RECONCILE_SOURCE_LIMIT;
  const rows = rowsReadWithOneExtra.slice(0, RECONCILE_SOURCE_LIMIT);
  await reportOperationalActions(rows.map((row) => ({
    source: definition.source,
    key: definition.key(row),
    area: definition.area,
    ...definition.action(row),
    incrementOccurrence: false,
  } satisfies ReportOperationalActionInput)), now);
  if (!truncated) {
    await reconcileOperationalActionSource(definition.source, rows.map(definition.key), now);
    return rows.length;
  }
  const { overflow } = definition;
  await reportOperationalActions([{
    source: definition.source,
    key: "overflow",
    area: definition.area,
    actionType: overflow.actionType,
    title: overflow.title,
    description:
      `A reconciliação leu ${RECONCILE_SOURCE_LIMIT} ${overflow.what}; o restante não foi reconcilado neste ciclo.`,
    priority: 90,
    risk: OperationalRisk.HIGH,
    resource: overflow.resource,
    resourceId: overflow.resourceId,
    evidence: { limit: RECONCILE_SOURCE_LIMIT, truncated: true },
    incrementOccurrence: false,
  } satisfies ReportOperationalActionInput], now);
  return rows.length;
}

/** Só o caso que já é trabalho do dono; antes disso o revival ainda tenta sozinho. */
async function readOpenTrainingCases(now: Date) {
  return prisma.trainingCase.findMany({
    where: trainingCaseDueForOwnerWhere(now),
    orderBy: { createdAt: "asc" },
    take: RECONCILE_SOURCE_LIMIT + 1,
    select: { id: true, evento: true, esporte: true, candidatesJson: true, createdAt: true },
  });
}

/**
 * A ação de cada caso de treino na caixa: a reconciliação a abre quando o caso
 * entra na fila Vincular e a reabre quando ele volta. O casamento do dia conta a
 * fila pelo instante gravado nela.
 */
export const TRAINING_CASE_ACTION = { actionType: "training.resolve", resource: "training-case" } as const;

const TRAINING_SOURCE: ActionSource<Awaited<ReturnType<typeof readOpenTrainingCases>>[number]> = {
  source: "training",
  area: "matching",
  key: (item) => item.id,
  action: (item) => {
    const candidates = Array.isArray(item.candidatesJson) ? item.candidatesJson.length : 0;
    return {
      actionType: TRAINING_CASE_ACTION.actionType,
      title: `Resolver identidade: ${item.evento}`,
      description: candidates > 0
        ? `${candidates} candidato(s) aguardando decisão humana.`
        : "A busca automática ainda não achou o jogo, horas depois do início; corrija o nome do evento na ficha da aposta.",
      priority: candidates > 0 ? 70 : 55,
      risk: OperationalRisk.MEDIUM,
      resource: TRAINING_CASE_ACTION.resource,
      resourceId: item.id,
      evidence: { esporte: item.esporte, candidates, openedAt: item.createdAt.toISOString() },
      command: { name: "training.resolve", caseId: item.id },
    };
  },
  overflow: {
    actionType: "training.overflow", title: "Treino truncado na reconciliação",
    what: "casos de treino", resource: TRAINING_CASE_ACTION.resource, resourceId: "overflow",
  },
};

const DEAD_LETTER_SOURCE: ActionSource<DeadLetterRow> = {
  source: "dlq",
  area: "filas",
  key: (item) => item.id,
  action: (item) => {
    // Recusa de negócio é a regra funcionando: não compete com uma falha do
    // sistema no topo da caixa.
    const business = item.classe === "business";
    const post = item.post;
    const { status, nextStep } = deadLetterGuidance({ dlqClass: item.classe, waitsFor: item.waitsFor, hasPost: post !== null });
    return {
      actionType: "dlq.replay",
      title: post
        ? `Post não processado · ${post.bankroll ?? (post.channelId ? `canal ${post.channelId}` : "conversa com o bot")}`
          + (post.messageId !== null ? ` · mensagem ${post.messageId}` : "")
        : `Revisar falha em ${item.fila}`,
      // O erro vai na descrição porque esta é a única linha da caixa para um job
      // morto: o watcher da DLQ só notifica.
      description: [post ? describeTelegramPost(post) : null, status,
        item.erro ? `Erro: ${item.erro}` : null, `👉 ${nextStep}`]
        .filter(Boolean).join("\n"),
      priority: business ? 60 : 80,
      risk: business ? OperationalRisk.MEDIUM : OperationalRisk.HIGH,
      resource: "pgboss-job",
      resourceId: item.id,
      evidence: {
        fila: item.fila,
        createdAt: item.criadoEm.toISOString(),
        error: item.erro,
        ...(item.classe ? { classe: item.classe } : {}),
        ...(item.waitsFor ? { aguarda: item.waitsFor } : {}),
        ...(post ? { tipster: post.bankroll, canal: post.channelId, messageId: post.messageId,
          mediaGroupId: post.mediaGroupId, trecho: post.excerpt } : {}),
      },
      command: { name: "dlq.replay", jobId: item.id },
    };
  },
  overflow: {
    actionType: "dlq.overflow", title: "Dead-letter truncada na reconciliação",
    what: "jobs da DLQ", resource: "pgboss-queue", resourceId: "dlq",
  },
};

/**
 * A ação de uma dead-letter fecha quando o job sai da fila, e o motivo da saída
 * está no rastro de quem a tirou. Sem rastro, ela expirou (ou foi apagada fora
 * do painel): dizer "condição normalizada" aí esconderia uma falha que ninguém
 * decidiu.
 */
async function closeVanishedDeadLetterActions(liveJobIds: readonly string[], now: Date): Promise<number> {
  const vanished = await prisma.operationalAction.findMany({
    where: {
      fingerprint: { startsWith: `${DEAD_LETTER_SOURCE.source}:` },
      status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] },
      resource: "pgboss-job",
      resourceId: { not: null, ...(liveJobIds.length > 0 ? { notIn: [...liveJobIds] } : {}) },
    },
    select: { id: true, fingerprint: true, resourceId: true },
  });
  if (vanished.length === 0) return 0;
  const trail = await prisma.auditEvent.findMany({
    where: {
      resourceId: { in: vanished.flatMap((action) => action.resourceId ? [action.resourceId] : []) },
      OR: [
        // O pedido pendente também conta: o replay apaga o job antes de marcar o
        // sucesso, e a reconciliação pode passar bem nesse intervalo.
        { action: "dlq_replay", resource: "pgboss_job", outcome: { in: ["pending", "success"] } },
        { action: "job.dlq_discarded" },
        { action: SCHEDULED_TICK_DISCARD_ACTION },
      ],
    },
    select: { action: true, resourceId: true },
  });
  const exitOf = new Map(trail.map((row) => [row.resourceId, row.action]));
  const byNote = new Map<string, Array<{ id: string; fingerprint: string }>>();
  for (const action of vanished) {
    const note = deadLetterExitNote(exitOf.get(action.resourceId) ?? null);
    byNote.set(note, [...(byNote.get(note) ?? []), { id: action.id, fingerprint: action.fingerprint }]);
  }
  let closed = 0;
  for (const [note, actions] of byNote) closed += await closeGcActions(actions, note, now);
  return closed;
}

export function deadLetterExitNote(exitAction: string | null): string {
  if (exitAction === "dlq_replay") return "Reprocessada: a tarefa voltou para a fila de origem.";
  if (exitAction === "job.dlq_discarded") return "Descartada: a aposta da tarefa foi removida.";
  if (exitAction === SCHEDULED_TICK_DISCARD_ACTION) {
    return "Descartada: era um disparo de tarefa agendada, e o disparo seguinte refaz o trabalho.";
  }
  return "Saiu da fila sem decisão: a falha expirou da dead-letter ou foi apagada fora do painel. "
    + "O erro continua registrado nesta ação.";
}

/**
 * Quando o esporte não confirmado chega ao dono. O pendente, 40 min antes do
 * jogo: até lá o resolvedor ainda tenta sozinho, inclusive nas vezes de 3 h e
 * de 45 min antes do início. Sem horário lido não há "antes do jogo": ele
 * chega no fim da busca automática, quando o Telegram avisa o dono, e esse
 * prazo também vale para o jogo distante. O conflito para o resolvedor e só o
 * dono decide, então chega logo depois da captura.
 */
function sportAttentionWindow(now: Date) {
  return {
    capturedBefore: new Date(now.getTime() - 10 * 60_000),
    kickoffBefore: new Date(now.getTime() + 40 * 60_000),
    backoffEndedBefore: new Date(now.getTime() - SPORT_RESOLUTION_BACKOFF_MS),
  };
}

async function readUnconfirmedSports(now: Date) {
  const { capturedBefore, kickoffBefore, backoffEndedBefore } = sportAttentionWindow(now);
  return prisma.bet.findMany({
    where: {
      deletedAt: null,
      OR: [
        { sportResolutionStatus: "CONFLICT", registradoEm: { lte: capturedBefore } },
        { sportResolutionStatus: { in: ["PENDING", "CONFLICT"] }, kickoffInferido: false, data: { lte: kickoffBefore } },
        { sportResolutionStatus: "PENDING", registradoEm: { lte: backoffEndedBefore } },
      ],
    },
    orderBy: [{ data: "asc" }, { id: "asc" }],
    take: RECONCILE_SOURCE_LIMIT + 1,
    select: {
      id: true,
      evento: true,
      data: true,
      registradoEm: true,
      sportResolutionStatus: true,
      sportConfidence: true,
      sportSource: true,
      sportEvidence: true,
      bankroll: { select: { nome: true } },
    },
  });
}

function sportResolutionSource(
  now: Date,
): ActionSource<Awaited<ReturnType<typeof readUnconfirmedSports>>[number]> {
  const { kickoffBefore } = sportAttentionWindow(now);
  return {
    source: "sport-resolution",
    area: "captura",
    key: (item) => item.id,
    action: (item) => ({
      actionType: "sport.resolve",
      title: `Confirmar esporte: ${item.evento}`,
      description: sportPendingMessage(item.sportEvidence) ?? (item.sportResolutionStatus === "CONFLICT"
        ? `Há evidências conflitantes. Revise a aposta do tipster ${item.bankroll.nome}.`
        : `A modalidade ainda não foi confirmada na aposta do tipster ${item.bankroll.nome}.`),
      priority: item.data.getTime() <= kickoffBefore.getTime() ? 85 : 65,
      risk: OperationalRisk.MEDIUM,
      resource: "bet",
      resourceId: item.id,
      evidence: {
        status: item.sportResolutionStatus,
        confidence: item.sportConfidence,
        source: item.sportSource,
        kickoff: item.data.toISOString(),
        capturedAt: item.registradoEm.toISOString(),
        candidates: item.sportEvidence ?? {},
      },
    }),
    overflow: {
      actionType: "sport-resolution.overflow", title: "Esporte pendente truncado na reconciliação",
      what: "apostas sem esporte confirmado", resource: "bet", resourceId: "overflow",
    },
  };
}

/**
 * Bets que não devem receber o card genérico `settlement.parado`: as que já têm
 * um incidente específico de liquidação, e os jogos adiados ainda no prazo de
 * espera do FlashScore.
 */
async function listSettlementParadoExclusions(now: Date): Promise<string[]> {
  const [incidentRows, postponedIds] = await Promise.all([
    prisma.operationalAction.findMany({
      where: {
        fingerprint: { startsWith: "settlement." },
        actionType: "incident.review",
        resource: "bet",
        resourceId: { not: null },
        status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] },
      },
      select: { resourceId: true },
      distinct: ["resourceId"],
    }),
    listPostponedWaitingBetIds(now),
  ]);

  return [
    ...new Set([
      ...incidentRows.flatMap((row) => row.resourceId ? [row.resourceId] : []),
      ...postponedIds,
    ]),
  ];
}

async function readStalledSettlements(now: Date, excluded: string[]) {
  return prisma.bet.findMany({
    where: {
      status: BetStatus.PENDING,
      deletedAt: null,
      data: { lte: new Date(now.getTime() - SETTLEMENT_ATRASO_MS) },
      kickoffInferido: false,
      ...(excluded.length > 0 ? { id: { notIn: excluded } } : {}),
    },
    orderBy: [{ data: "asc" }, { id: "asc" }],
    take: RECONCILE_SOURCE_LIMIT + 1,
    select: {
      id: true,
      evento: true,
      data: true,
      mercado: true,
      selecao: true,
      sportResolutionStatus: true,
      bankroll: { select: { nome: true } },
      sharp: { select: { identityStatus: true } },
      result: { select: { resultSnapshot: true } },
    },
  });
}

function resultOutcome(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const outcome = (snapshot as { outcome?: unknown }).outcome;
  return typeof outcome === "string" ? outcome : null;
}

/**
 * O FlashScore liquida por nome, sem identidade sharp: a parada se explica pela
 * observação dele. Ele só olha aposta com esporte confirmado.
 */
export function stalledSettlementText(bet: { sportConfirmed: boolean; flashscoreOutcome: string | null }): string {
  if (!bet.sportConfirmed) {
    return "O esporte não foi confirmado, e sem ele o FlashScore não olha a aposta: resolva em Operações.";
  }
  const { flashscoreOutcome } = bet;
  if (flashscoreOutcome === "matched") {
    return "O FlashScore casou — falta o placar ou o par da estatística.";
  }
  if (flashscoreOutcome === null) {
    return "O FlashScore ainda não observou este jogo: resolva em Operações.";
  }
  if (FLASHSCORE_UNCOVERED_OUTCOMES.includes(flashscoreOutcome)) {
    return "O FlashScore não liquida este esporte: resolva em Operações.";
  }
  return "O FlashScore não achou o jogo, então o placar automático não chega: resolva em Operações.";
}

/**
 * Aposta com jogo encerrado que segue PENDING é perda silenciosa: o lucro nunca
 * entra no ledger e a amostra de CLV some sem ninguém perceber.
 */
function stalledSettlementSource(
  now: Date,
): ActionSource<Awaited<ReturnType<typeof readStalledSettlements>>[number]> {
  return {
    source: "settlement.parado",
    area: "settlement",
    key: (bet) => bet.id,
    action: (bet) => {
      const horas = Math.floor((now.getTime() - bet.data.getTime()) / 3_600_000);
      const identidade = bet.sharp?.identityStatus ?? null;
      const flashscoreOutcome = resultOutcome(bet.result?.resultSnapshot);
      const pedido = hasNonScoreStatQualifier(bet.mercado, bet.selecao)
        ? pedidoDeParEstatistico({
            mercado: bet.mercado,
            selecao: bet.selecao,
            evento: bet.evento,
          })
        : null;
      return {
        actionType: "bet.settle",
        title: `Liquidar: ${bet.evento}`,
        description:
          `O jogo terminou ${spRelative(bet.data, now)} e a aposta do tipster ${bet.bankroll.nome} segue PENDENTE. `
          + (pedido
            ? pedido.sentence
            : stalledSettlementText({ sportConfirmed: bet.sportResolutionStatus === "CONFIRMED", flashscoreOutcome })),
        // Quanto mais velha, mais alto: um dia parado já compete com a DLQ.
        priority: horas >= 24 ? 85 : 65,
        risk: OperationalRisk.MEDIUM,
        resource: "bet",
        resourceId: bet.id,
        evidence: {
          kickoff: bet.data.toISOString(),
          horasParada: horas,
          mercado: bet.mercado,
          selecao: bet.selecao,
          tipster: bet.bankroll.nome,
          identidade,
          flashscoreOutcome,
          ...(pedido?.family ? { statistic: pedido.family } : {}),
        },
      };
    },
    overflow: {
      actionType: "settlement.parado.overflow", title: "Apostas paradas truncadas na reconciliação",
      what: "apostas paradas", resource: "bet", resourceId: "overflow",
    },
  };
}

/**
 * Encerra os incidentes de IA-Judge e da busca pós-jogo na BridgeOdds quando o
 * ciclo correspondente passou 24h sem falhar.
 */
export async function reconcileWatchdogActions(now = new Date()): Promise<void> {
  const since = new Date(now.getTime() - WATCHDOG_WINDOW_MS);
  const recentIaJudgeFails = await prisma.auditEvent.count({
    where: { action: "ia_judge.cycle_failure", createdAt: { gte: since } },
  });
  if (recentIaJudgeFails === 0) {
    await reconcileOperationalActionSource("settlement.ia-judge", [], now);
  }

  const recentPostgameFails = await prisma.auditEvent.count({
    where: { action: "worker.bridge_postgame", outcome: "partial", createdAt: { gte: since } },
  });
  if (recentPostgameFails === 0) {
    await reconcileOperationalActionSource("sharp.bridge_postgame", [], now);
  }
}

/**
 * Reconcilia as fontes acionáveis sem apagar histórico: treino aberto, DLQ,
 * modalidade a confirmar, aposta parada e os incidentes vigiados.
 */
/**
 * `pre-pinnacle`: sugestão de modo sharp. `telegram.result-review` e
 * `telegram.edit-parse`: resultado e edição do post do tipster, que não mudam
 * mais a aposta. `telegram.capture-batch`: o lote recusado virou pendência do
 * post (`telegram.capture-review`). `closing.revival`: a repescagem virou a
 * busca pós-jogo na BridgeOdds (`sharp.bridge_postgame`).
 */
const RETIRED_ACTION_SOURCES = [
  "pre-pinnacle", "telegram.result-review", "telegram.edit-parse", "telegram.capture-batch", "closing.revival",
] as const;

export async function reconcileOperationalActions(now = new Date()): Promise<{
  training: number;
  deadLetters: number;
  sportResolution: number;
  settlementParado: number;
}> {
  const paradasExcluidas = await listSettlementParadoExclusions(now);
  const [trainingRows, deadLetterRows, sportRows, paradasRows] = await Promise.all([
    readOpenTrainingCases(now),
    // Sem janela de idade: a ação só encerra quando o job sai da fila.
    listDeadLetters(RECONCILE_SOURCE_LIMIT + 1, null),
    readUnconfirmedSports(now),
    readStalledSettlements(now, paradasExcluidas),
  ]);

  const training = await syncActionSource(TRAINING_SOURCE, trainingRows, now);
  // Leitura truncada não prova que o job saiu: aí nada fecha neste ciclo.
  if (deadLetterRows.length <= RECONCILE_SOURCE_LIMIT) {
    await closeVanishedDeadLetterActions(deadLetterRows.map((row) => row.id), now);
  }
  const deadLetters = await syncActionSource(DEAD_LETTER_SOURCE, deadLetterRows, now);
  const sportResolution = await syncActionSource(sportResolutionSource(now), sportRows, now);
  // Fontes que não existem mais: ninguém reporta nem encerra o que ficou aberto.
  for (const source of RETIRED_ACTION_SOURCES) {
    await reconcileOperationalActionSource(source, [], now, { retired: true });
  }
  const settlementParado = await syncActionSource(stalledSettlementSource(now), paradasRows, now);
  await reconcileWatchdogActions(now);

  return { training, deadLetters, sportResolution, settlementParado };
}

/**
 * Fecha os alertas de "canal sem banca" assim que existir vínculo ativo. Eles
 * nascem com `autoResolve: false`, então a reconciliação por fonte não os toca:
 * só o vínculo real os encerra.
 */
export async function reconcileMappedTelegramChannelActions(now = new Date()): Promise<number> {
  const abertas = await prisma.operationalAction.findMany({
    where: {
      resource: "telegram-channel",
      resourceId: { not: null },
      status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] },
    },
    select: { id: true, resourceId: true },
  });
  const channelIds = abertas.flatMap((acao) => {
    try {
      return acao.resourceId == null ? [] : [BigInt(acao.resourceId)];
    } catch {
      return [];
    }
  });
  if (channelIds.length === 0) return 0;

  const mapped = await prisma.bankroll.findMany({
    where: { telegramChannelId: { in: channelIds } },
    select: { telegramChannelId: true },
  });
  const mappedIds = new Set(mapped.map((row) => String(row.telegramChannelId)));
  const normalizadas = abertas.filter(
    (acao) => acao.resourceId != null && mappedIds.has(acao.resourceId),
  );
  const falhas: Array<{ acaoId: string; canal: string | null; motivo: string }> = [];
  let fechadas = 0;
  for (const acao of normalizadas) {
    try {
      await closeOperationalAction(
        acao.id,
        "system",
        "RESOLVED",
        "Canal vinculado a um tipster ativo.",
        now,
      );
      fechadas += 1;
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      falhas.push({ acaoId: acao.id, canal: acao.resourceId, motivo });
      log.error(
        { err, acaoId: acao.id, canal: acao.resourceId },
        "falha ao fechar ação de canal mapeado; lote continua",
      );
    }
  }

  if (falhas.length > 0) {
    const amostra = falhas
      .slice(0, 5)
      .map((falha) => `• canal ${falha.canal}: ${falha.motivo}`)
      .join("\n");
    const resto = falhas.length > 5 ? `\n… e mais ${falhas.length - 5}.` : "";
    await sendOperationalAlert(
      `⚠️ ${falhas.length} aviso(s) de canal já vinculado não fecharam sozinhos\nOs demais seguiram normalmente.\n${amostra}${resto}\n`
        + "👉 Esses canais já têm tipster: feche os avisos à mão em Monitoramento.",
      {
        source: "ops.mapped-channel-actions",
        key: "batch-failure",
        title: "Falha ao fechar ações de canal mapeado",
        resource: "operational-action",
        evidence: { failed: falhas.length, acaoIds: falhas.slice(0, 20).map((f) => f.acaoId) },
        autoResolve: false,
      },
    );
  }
  return fechadas;
}
