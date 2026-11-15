import { createLogger } from "@/src/infra/logger";
import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";
import { ACOES_DE_AUDITORIA_DA_TRILHA } from "@/src/domain/trilha-da-aposta";
import { BRIDGE_SNAPSHOT_STALE_READ } from "@/src/providers/bridgeodds/snapshot-cache";

const log = createLogger("audit-purge");

/** Retenção padrão de AuditEvent (dias). */
export const AUDIT_RETENTION_DAYS = 30;
/** Drift/budget ficam mais tempo — investigação pós-fato. */
const AUDIT_CRITICAL_RETENTION_DAYS = 90;
/** Alterações administrativas/financeiras precisam cobrir um ciclo anual. */
export const AUDIT_FINANCIAL_RETENTION_DAYS = 365;

const CRITICAL_ACTIONS = [
  "bet_lucro_drift",
  "conta_drift",
  // Drift do ledger é da mesma família dos dois acima.
  "bet_ledger_drift",
  "budget_alert",
  // A causa de uma dead-letter retida mora aqui, não no job: tem de durar os
  // 90 dias em que a dead-letter espera decisão (`DEAD_LETTER_RETENTION_SECONDS`).
  "job.dlq_retained",
] as const;
const FINANCIAL_ACTIONS: readonly string[] = [...new Set([
  "conta.create", "conta.update", "conta.status", "conta.delete", "conta.movement",
  "bankroll.create", "bankroll.update", "bankroll.delete",
  // `bet.create` é a GÊNESE financeira da aposta: sem ela a trilha guardaria a
  // liquidação por 365 dias e perderia em 30 o registro do que foi liquidado.
  // `bet.not_taken_undone` entra pelo mesmo motivo de `bet.soft_delete` — os
  // dois mexem no ledger, um estornando e o outro desfazendo o estorno.
  "bet.create", "bet.edit", "bet.soft_delete", "bet.not_taken_undone",
  /**
   * Tudo que a TRILHA da aposta exibe, derivado do registro — nunca digitado
   * aqui: lista digitada à mão deixa evento que a ficha mostra cair aos 30 dias
   * e guarda nomes que ninguém grava. Evento novo no registro entra na retenção
   * sozinho. O `Set` absorve a sobreposição legítima com as ações financeiras
   * nomeadas acima (`create`/`edit`/`soft_delete`).
   */
  ...ACOES_DE_AUDITORIA_DA_TRILHA,
])];
/**
 * A remoção de alias de mercado é o que impede a sincronização do catálogo
 * (`services/mercados/catalog-sync.ts`) de recolocar o alias que o dono tirou.
 * Fica enquanto o alias continua fora daquele mercado, como o snapshot do
 * soft-delete; voltou o alias, sai em um ano.
 */
const MARKET_ALIAS_REMOVAL_ACTION = "market_alias.delete";
/**
 * Tudo que escapa dos 30 dias padrão: é a lista que o purge normal poupa.
 * Exportada porque os testes `trilha-da-aposta` provam duas coisas sobre ela:
 * que cobre o que a ficha exibe, e que nenhuma entrada é letra morta (nome que
 * ninguém grava, como um rótulo de métrica de `observeAction`).
 */
export const ACOES_COM_RETENCAO_ESTENDIDA: readonly string[] = [
  ...CRITICAL_ACTIONS,
  ...FINANCIAL_ACTIONS,
  MARKET_ALIAS_REMOVAL_ACTION,
];

/** Consumo de provider por hora/dia: histórico de um trimestre basta para conferir cobrança. */
const PROVIDER_BUDGET_RETENTION_DAYS = 90;

const PURGE_BATCH_SIZE = 5_000;
const MAX_BATCHES_PER_RUN = 20;
const REVOKED_SESSION_RETENTION_DAYS = 30;

async function deleteInBatches(
  label: string,
  deleteBatch: () => Promise<number>,
): Promise<number> {
  let deleted = 0;
  let lastCount = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    const count = await deleteBatch();
    lastCount = count;
    deleted += count;
    if (count < PURGE_BATCH_SIZE) break;
  }
  if (lastCount === PURGE_BATCH_SIZE) {
    log.warn(
      { label, deleted, maxBatches: MAX_BATCHES_PER_RUN },
      "purga atingiu o teto seguro; o restante continuará na próxima execução",
    );
  }
  return deleted;
}

async function deleteAuditBatches(label: string, predicate: Prisma.Sql): Promise<number> {
  return deleteInBatches(label, () => prisma.$executeRaw(Prisma.sql`
      DELETE FROM audit_events
      WHERE id IN (
        SELECT id FROM audit_events
        WHERE ${predicate}
        ORDER BY "createdAt" ASC
        LIMIT ${PURGE_BATCH_SIZE}
      )
    `));
}

/** AuditEvent por faixa de retenção: comum 30d, críticos 90d, financeiros e remoção de alias de mercado 365d. */
async function purgeAuditEventsByRetention(now: Date) {
  const cutoffNormal = new Date(now.getTime() - AUDIT_RETENTION_DAYS * 86_400_000);
  const cutoffCritical = new Date(now.getTime() - AUDIT_CRITICAL_RETENTION_DAYS * 86_400_000);
  const cutoffFinancial = new Date(now.getTime() - AUDIT_FINANCIAL_RETENTION_DAYS * 86_400_000);

  // Mesma tabela e índices: sequencial evita contenção de três DELETEs concorrentes.
  const deletedNormal = await deleteAuditBatches("audit-normal", Prisma.sql`
    "createdAt" < ${cutoffNormal}
    AND NOT (action = 'capture.followup' AND outcome = 'pending')
    -- O recibo impede repetir um aviso enquanto o mesmo ciclo segue aberto.
    AND NOT (
      action = 'ops.alert_once_delivered' AND resource = 'operational_action'
      AND EXISTS (
        SELECT 1 FROM operational_actions AS incident
        WHERE incident.id = audit_events."resourceId" AND incident.status IN ('OPEN', 'ACKED')
          AND incident."reopenCount"::text = audit_events.details->>'cycle'
      )
    )
    AND action NOT IN (${Prisma.join([...ACOES_COM_RETENCAO_ESTENDIDA])})
  `);
  const deletedCritical = await deleteAuditBatches("audit-critical", Prisma.sql`
    "createdAt" < ${cutoffCritical}
    AND action IN (${Prisma.join([...CRITICAL_ACTIONS])})
  `);
  const deletedFinancial = await deleteAuditBatches("audit-financial", Prisma.sql`
    "createdAt" < ${cutoffFinancial}
    AND action IN (${Prisma.join([...FINANCIAL_ACTIONS])})
    -- Antes dos recibos, esta auditoria era a única prova da origem consumida.
    AND NOT (
      action = 'bet.duplicate_absorbed' AND resource = 'bet'
      AND COALESCE(details->>'source', '') <> '' AND COALESCE(details->>'sourceExternalId', '') <> ''
      AND EXISTS (SELECT 1 FROM bets WHERE bets.id = audit_events."resourceId")
      AND NOT EXISTS (
        SELECT 1 FROM absorbed_bet_sources AS receipt
        WHERE receipt.source = audit_events.details->>'source'
          AND receipt."sourceExternalId" = audit_events.details->>'sourceExternalId'
      )
    )
    -- Estes registros sustentam a decisão de não recriar o canal, sem prazo.
    AND NOT (action = 'bankroll.update' AND details->>'previousTelegramChannelId' IS NOT NULL)
    AND NOT (
      action = 'bankroll.delete'
      AND COALESCE(details->'telegramChannelIds', '[]'::jsonb) <> '[]'::jsonb
      AND jsonb_typeof(details->'telegramChannelIds') = 'array'
    )
    AND NOT (
      action = 'bet.soft_delete'
      AND EXISTS (
        SELECT 1
        FROM bets AS active_tombstone
        WHERE active_tombstone.id = audit_events."resourceId"
          AND active_tombstone."notTakenAt" IS NOT NULL
      )
    )
  `);
  const deletedMarketAliasRemoval = await deleteAuditBatches("audit-market-alias-removal", Prisma.sql`
    "createdAt" < ${cutoffFinancial}
    AND action = ${MARKET_ALIAS_REMOVAL_ACTION}
    AND EXISTS (
      SELECT 1
      FROM mercados_alias AS restored
      WHERE restored."aliasNormalizado" = audit_events.details->>'aliasNormalizado'
        AND restored."mercadoPadraoId" = audit_events.details->>'mercadoPadraoId'
    )
  `);
  return { deletedNormal, deletedCritical, deletedFinancial, deletedMarketAliasRemoval };
}

/** Linhas com prazo próprio em `expiresAt`, apagadas pela chave em lotes. */
async function deleteExpiredRows(label: string, table: string, key: string, now: Date): Promise<number> {
  const tableSql = Prisma.raw(table);
  const keySql = Prisma.raw(`"${key}"`);
  return deleteInBatches(label, () => prisma.$executeRaw(Prisma.sql`
    DELETE FROM ${tableSql}
    WHERE ${keySql} IN (
      SELECT ${keySql} FROM ${tableSql}
      WHERE "expiresAt" < ${now}
      ORDER BY "expiresAt" ASC
      LIMIT ${PURGE_BATCH_SIZE}
    )
  `));
}

/**
 * Cache de provider vencido. Quase nada lê linha vencida (`readProviderCache`
 * a recusa), e a tabela crescia sem purga. A exceção é o snapshot da
 * BridgeOdds, que a identidade lê vencido até 30 dias depois de colhido.
 */
async function deleteExpiredProviderCaches(now: Date): Promise<number> {
  const staleRead = BRIDGE_SNAPSHOT_STALE_READ;
  const staleReadSince = new Date(now.getTime() - staleRead.maxAgeMs);
  return deleteInBatches("provider-caches", () => prisma.$executeRaw(Prisma.sql`
    DELETE FROM provider_caches
    WHERE (provider, key) IN (
      SELECT provider, key FROM provider_caches
      WHERE "expiresAt" < ${now}
        AND NOT (
          provider = ${staleRead.provider}
          AND starts_with(key, ${staleRead.keyPrefix})
          AND "fetchedAt" >= ${staleReadSince}
        )
      ORDER BY "expiresAt" ASC
      LIMIT ${PURGE_BATCH_SIZE}
    )
  `));
}

/**
 * Retenção diária: AuditEvent por faixa, sessões expiradas ou revogadas, as
 * tabelas de vida curta (álbuns, rascunhos de DM, evidência de captura,
 * cooldowns do IA-Judge e cache de provider) e o consumo antigo de provider.
 * Retorna quantas linhas saíram de cada uma.
 */
export async function purgeOldAuditEvents(
  now: Date = new Date(),
): Promise<{
  deletedNormal: number;
  deletedCritical: number;
  deletedFinancial: number;
  deletedMarketAliasRemoval: number;
  deletedSessions: number;
  deletedAlbums: number;
  deletedDmDrafts: number;
  deletedCaptureEvidence: number;
  deletedCooldowns: number;
  deletedProviderCaches: number;
  deletedProviderBudgets: number;
}> {
  const audit = await purgeAuditEventsByRetention(now);
  const revokedSessionCutoff = new Date(
    now.getTime() - REVOKED_SESSION_RETENTION_DAYS * 86_400_000,
  );
  const deletedSessions = await deleteInBatches("auth-sessions", () => prisma.$executeRaw`
    DELETE FROM auth_device_sessions
    WHERE id IN (
      SELECT id FROM auth_device_sessions
      WHERE "expiresAt" < ${now}
         OR "revokedAt" < ${revokedSessionCutoff}
      ORDER BY "expiresAt" ASC
      LIMIT ${PURGE_BATCH_SIZE}
    )
  `);
  const deletedAlbums = await deleteExpiredRows("telegram-albums", "telegram_media_albums", "mediaGroupId", now);
  const deletedDmDrafts = await deleteExpiredRows("telegram-drafts", "telegram_dm_drafts", "id", now);
  const deletedCaptureEvidence = await deleteExpiredRows("bet-capture-evidence", "bet_capture_evidence", "betId", now);
  const deletedCooldowns = await deleteExpiredRows("ia-judge-cooldowns", "ia_judge_cooldowns", "key", now);
  const deletedProviderCaches = await deleteExpiredProviderCaches(now);
  const budgetCutoff = new Date(now.getTime() - PROVIDER_BUDGET_RETENTION_DAYS * 86_400_000);
  // Poucas linhas por dia (uma por provider e período): um DELETE só basta.
  const { count: deletedProviderBudgets } = await prisma.providerBudget.deleteMany({
    where: { updatedAt: { lt: budgetCutoff } },
  });
  const result = {
    ...audit,
    deletedCooldowns,
    deletedProviderCaches,
    deletedProviderBudgets,
    deletedSessions,
    deletedAlbums,
    deletedDmDrafts,
    deletedCaptureEvidence,
  };
  if (Object.values(result).some((count) => count > 0)) {
    log.info(result, "purga de retenção concluída");
  }
  return result;
}
