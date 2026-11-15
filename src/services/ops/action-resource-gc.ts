import { Prisma } from "@/src/generated/prisma/client";
import { OperationalActionStatus } from "@/src/generated/prisma/enums";
import { ACTIVE_OPERATIONAL_ACTION_STATUSES } from "@/src/domain/operational-action-status";
import { postExternalIdsWhere, postIdOfExternalId, telegramChannelSource } from "@/src/domain/telegram-source";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { BET_LEDGER_ALERT_SOURCE } from "@/src/services/ops/consistency/bet-ledger";
import { recordActionAuditTx } from "@/src/services/ops/operational-actions";

const log = createLogger("action-gc");

/** Quantas ações são verificadas por rodada — a caixa nunca chega perto disso. */
const LIMITE = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type GcAction = { id: string; fingerprint: string };
type ResourceGcAction = GcAction & { resource: string | null; resourceId: string | null };
type SettlementGcAction = GcAction & { resourceId: string | null };

/** Fecha as ações ainda ativas com a nota dada, e audita a transição de cada uma. */
export async function closeGcActions(
  actions: readonly GcAction[],
  resolutionNote: string,
  now: Date,
): Promise<number> {
  if (actions.length === 0) return 0;
  return prisma.$transaction((tx) =>
    closeGcActionsTx(tx, actions, resolutionNote, now, "system")
  );
}

async function closeGcActionsTx(
  tx: Prisma.TransactionClient,
  actions: readonly GcAction[],
  resolutionNote: string,
  now: Date,
  actor: string,
): Promise<number> {
  if (actions.length === 0) return 0;
  // UPDATE ... RETURNING mantém a condição de estado até a escrita e devolve
  // exatamente o que transitou, em uma ida ao banco. Assim uma corrida com
  // resolução humana não é sobrescrita nem auditada como auto-resolução.
  const transitioned = await tx.operationalAction.updateManyAndReturn({
    where: {
      id: { in: actions.map((action) => action.id) },
      status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] },
    },
    data: { status: OperationalActionStatus.RESOLVED, resolvedAt: now, resolutionNote },
    select: { id: true, fingerprint: true },
  });
  if (transitioned.length === 0) return 0;
  await recordActionAuditTx(
    tx,
    transitioned.map((action) => ({
      ...action,
      status: OperationalActionStatus.RESOLVED,
    })),
    "auto_resolved",
    actor,
    resolutionNote,
  );
  return transitioned.length;
}

/**
 * Fecha imediatamente tudo que deixou de ser acionável junto com o recurso.
 *
 * A varredura periódica abaixo continua como rede de segurança para corridas e
 * escritores legados. O caminho de negócio deve chamar esta variante na mesma
 * transação que exclui o alvo: sem isso a Caixa de ações oferece botões para
 * uma aposta já removida por até cinco minutos.
 */
export async function resolverAcoesDoRecursoTx(
  tx: Prisma.TransactionClient,
  params: {
    resource: string;
    resourceId: string;
    actor: string;
    now?: Date;
    resolutionNote?: string;
  },
): Promise<number> {
  const actions = await tx.operationalAction.findMany({
    where: {
      resource: params.resource,
      resourceId: params.resourceId,
      status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] },
    },
    select: { id: true, fingerprint: true },
  });
  return closeGcActionsTx(
    tx,
    actions,
    params.resolutionNote ?? "Alvo excluído — nada mais a decidir nesta ação.",
    params.now ?? new Date(),
    params.actor,
  );
}

/**
 * Fecha ação cujo ALVO deixou de existir.
 *
 * A reconciliação normal respeita `autoResolve: false`, mas ação sobre aposta
 * excluída ou job que saiu de `pgboss.job` não tem decisão possível, e caixa
 * que acumula item morto se aprende a ignorar. O rastro fica: o `AuditEvent`
 * do fechamento e o `job.dlq_retained` original.
 *
 * O ledger divergente fica de fora: ele confere também a aposta removida (o
 * estorno tem de zerá-la) e a própria checagem diária o fecha quando a
 * divergência some.
 */
export async function resolverAcoesSemRecurso(now = new Date()): Promise<number> {
  const resolutionNote = "Alvo não existe mais (excluído ou expirado) — nada a decidir.";
  let afterId: string | null = null;
  let total = 0;
  for (;;) {
    const abertas: ResourceGcAction[] = await prisma.operationalAction.findMany({
      where: {
        status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] },
        resource: { in: ["bet", "bankroll", "pgboss-job"] },
        resourceId: { not: null },
        NOT: { fingerprint: { startsWith: `${BET_LEDGER_ALERT_SOURCE}:` } },
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      select: { id: true, fingerprint: true, resource: true, resourceId: true },
      orderBy: { id: "asc" },
      take: LIMITE,
    });
    if (abertas.length === 0) break;
    afterId = abertas.at(-1)!.id;

    const idsDe = (recurso: string): string[] => [
      ...new Set(abertas.flatMap((acao) =>
        acao.resource === recurso && acao.resourceId != null ? [acao.resourceId] : []
      )),
    ];
    const betIds = idsDe("bet");
    const bankrollIds = idsDe("bankroll");
    // Id inválido não é prova de ausência: fica de fora da varredura.
    const jobIds = idsDe("pgboss-job").filter((id) => UUID.test(id));
    const [bets, bankrolls, jobs] = await Promise.all([
      betIds.length ? prisma.bet.findMany({
        where: { id: { in: betIds }, deletedAt: null }, select: { id: true },
      }) : [],
      bankrollIds.length ? prisma.bankroll.findMany({
        where: { id: { in: bankrollIds } }, select: { id: true },
      }) : [],
      jobIds.length ? prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id FROM pgboss.job WHERE id = ANY(${jobIds}::uuid[])
      ` : [],
    ]);
    const vivos = new Map<string, Set<string>>([
      ["bet", new Set(bets.map((row) => row.id))],
      ["bankroll", new Set(bankrolls.map((row) => row.id))],
      ["pgboss-job", new Set(jobs.map((row) => row.id))],
    ]);
    const orfas = abertas.filter((acao) => {
      if (acao.resourceId == null) return false;
      if (acao.resource === "pgboss-job" && !UUID.test(acao.resourceId)) return false;
      return !vivos.get(acao.resource ?? "")?.has(acao.resourceId);
    });
    total += await closeGcActions(orfas, resolutionNote, now);
    if (abertas.length < LIMITE) break;
  }
  if (total > 0) log.info({ fechadas: total }, "ações sem recurso encerradas");
  return total;
}

/**
 * Fecha a pendência de captura (`capture_review`) do post que virou aposta
 * depois: a edição do tipster completou o rascunho, o dono pediu a captura ou
 * registrou pelo painel com a origem do post. A aposta removida depois também
 * conta: o post foi capturado. O lote alterado fica: as apostas do post já
 * existiam quando a releitura divergiu, e só o dono decide qual vale.
 */
export async function resolverRevisoesDeCapturaGravadas(now = new Date()): Promise<number> {
  let afterId: string | null = null;
  let total = 0;
  for (;;) {
    const abertas: Array<GcAction & { resourceId: string | null; evidence: unknown }> = await prisma.operationalAction.findMany({
      where: {
        status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] },
        actionType: "capture_review",
        resource: "telegram-channel",
        resourceId: { not: null },
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      select: { id: true, fingerprint: true, resourceId: true, evidence: true },
      orderBy: { id: "asc" },
      take: LIMITE,
    });
    if (abertas.length === 0) break;
    afterId = abertas.at(-1)!.id;
    const postsByChat = new Map<string, Array<{ action: GcAction; messageId: string }>>();
    for (const acao of abertas) {
      if ((acao.evidence as { reason?: unknown } | null)?.reason === "lote_alterado_precisa_revisao") continue;
      const match = /^(-?\d+):(\d+)$/.exec(acao.resourceId ?? "");
      if (!match?.[1] || !match[2]) continue;
      const posts = postsByChat.get(match[1]) ?? [];
      posts.push({ action: { id: acao.id, fingerprint: acao.fingerprint }, messageId: match[2] });
      postsByChat.set(match[1], posts);
    }
    const capturadas: GcAction[] = [];
    for (const [chatId, posts] of postsByChat) {
      const bets = await prisma.bet.findMany({
        where: { source: telegramChannelSource(chatId), ...postExternalIdsWhere(posts.map((post) => post.messageId)) },
        select: { sourceExternalId: true },
      });
      const gravados = new Set(bets.map((bet) => bet.sourceExternalId && postIdOfExternalId(bet.sourceExternalId)));
      capturadas.push(...posts.filter((post) => gravados.has(post.messageId)).map((post) => post.action));
    }
    total += await closeGcActions(capturadas, "O post virou aposta — nada mais a conferir.", now);
    if (abertas.length < LIMITE) break;
  }
  if (total > 0) log.info({ fechadas: total }, "pendências de captura encerradas: o post virou aposta");
  return total;
}

/**
 * A legenda do post fica na evidência só enquanto a pendência está aberta:
 * a caixa de ações não tem purga, e o post é do tipster.
 */
export async function apagarLegendaDeRevisoesEncerradas(): Promise<number> {
  return prisma.$executeRaw`
    UPDATE operational_actions
    SET evidence = evidence - 'caption'
    WHERE "actionType" = 'capture_review'
      AND status::text NOT IN (${Prisma.join([...ACTIVE_OPERATIONAL_ACTION_STATUSES])})
      AND evidence ? 'caption'
  `;
}

/** Fontes que só existem enquanto a aposta está PENDING e precisa de mão. */
const LIQUIDACAO_ENQUANTO_PENDENTE = [
  "settlement.score-unsupported:",
  "settlement.flashscore-missing-stats:",
  "settlement.flashscore-stat-unsupported:",
  "settlement.flashscore-extra-time:",
  "settlement.flashscore-interrupted:",
  "settlement.ticket-interrupted:",
  "settlement.flashscore-goalscorer:",
  "settlement.flashscore-ordered-goalscorer:",
  "settlement.flashscore-player-prop:",
  "settlement.score-feed-conflict:",
  "settlement.parado:",
] as const;

/**
 * Fecha incidente de liquidação quando a aposta já não está PENDING.
 * Recheck / conflito tipster×placar / telegram-conflict ficam — ainda há o que decidir.
 */
export async function resolverAcoesDeLiquidacaoResolvida(now = new Date()): Promise<number> {
  const resolutionNote = "Aposta já não está pendente — nada a liquidar nesta linha.";
  let afterId: string | null = null;
  let total = 0;
  for (;;) {
    const candidatas: SettlementGcAction[] = await prisma.operationalAction.findMany({
      where: {
        status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] },
        resource: "bet",
        resourceId: { not: null },
        OR: LIQUIDACAO_ENQUANTO_PENDENTE.map((prefix) => ({
          fingerprint: { startsWith: prefix },
        })),
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      select: { id: true, fingerprint: true, resourceId: true },
      orderBy: { id: "asc" },
      take: LIMITE,
    });
    if (candidatas.length === 0) break;
    afterId = candidatas.at(-1)!.id;
    const betIds = [...new Set(candidatas.flatMap((acao) =>
      acao.resourceId ? [acao.resourceId] : []
    ))];
    const pendentes = await prisma.bet.findMany({
      where: { id: { in: betIds }, deletedAt: null, status: "PENDING" },
      select: { id: true },
    });
    const aindaPendentes = new Set(pendentes.map((row) => row.id));
    const resolvidas = candidatas.filter((acao) =>
      acao.resourceId != null && !aindaPendentes.has(acao.resourceId)
    );
    total += await closeGcActions(resolvidas, resolutionNote, now);
    if (candidatas.length < LIMITE) break;
  }
  if (total > 0) {
    log.info({ fechadas: total }, "ações de liquidação encerradas após settle");
  }
  return total;
}
