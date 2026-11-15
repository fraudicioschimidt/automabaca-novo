import { formatSpDateTime } from "@/src/domain/dates";
import { OperationalRisk } from "@/src/generated/prisma/client";
import { readLogArchiveHealth, type BackupHealth, type LogArchiveReason } from "@/src/infra/observability-status";
import { raiseOperationalAlertOnce } from "@/src/services/ops/alerts";
import { reportOperationalAction, reconcileOperationalActionSource } from "@/src/services/ops/operational-actions";

const SOURCE = "log-archive";

const TITLES: Record<LogArchiveReason, string> = {
  collection_stale: "Coleta de logs atrasada", journal_gap_detected: "Lacuna detectada no histórico de logs",
  collection_backlog: "Coleta de logs acumulada", archive_space_low: "Arquivo de logs próximo do limite de espaço",
  export_stale: "Exportação criptografada de logs atrasada", export_backlog: "Exportação de logs acumulada",
  offsite_pending: "Primeira cópia de logs no computador pendente", offsite_invalid: "Comprovante de cópia dos logs inválido",
  offsite_stale: "Cópia de logs para o computador atrasada", offsite_incomplete: "Cópia de logs no computador incompleta",
  backup_failed: "Backup diário do banco falhou", backup_stale: "Backup diário do banco atrasado",
  backup_offsite_stale: "Cópia do backup no computador atrasada",
  watchdog_failed: "Verificação do arquivo de logs falhou", watchdog_unavailable: "Verificação do arquivo de logs indisponível",
};

function lastVerified(backup: BackupHealth | null): string {
  return backup?.createdAt
    ? `O último backup conferido é de ${formatSpDateTime(new Date(backup.createdAt))}.`
    : "Não há backup conferido publicado no servidor.";
}

function backupEvidence(reason: LogArchiveReason, backup: BackupHealth | null) {
  return { reason, backup: backup?.state ?? null, createdAt: backup?.createdAt ?? null, failedAt: backup?.failedAt ?? null };
}

/**
 * O atraso é o que chega ao Telegram, uma vez: a falha de uma noite o systemd
 * tenta de novo sozinho (30 min depois, até 3 vezes), e só quando nenhuma
 * tentativa salvou o dia o vigia passa das 26 h e chama o dono.
 */
async function reportBackupStale(backup: BackupHealth | null): Promise<void> {
  await raiseOperationalAlertOnce(
    `💾 Backup diário do banco atrasado\n${lastVerified(backup)}\n`
      + "👉 No servidor: journalctl -u automabaca-novo-backup --since '36 hours ago'. "
      + "O aviso fecha sozinho quando um backup conferido sair.",
    {
      source: SOURCE, key: "backup_stale", title: TITLES.backup_stale, risk: OperationalRisk.HIGH,
      evidence: backupEvidence("backup_stale", backup),
    },
  );
}

/**
 * Sem o comprovante do computador, o único backup está na própria VPS: se ela
 * se perder, ele vai junto. Por isso chama o dono como o atraso do backup.
 */
async function reportBackupOffsiteStale(backup: BackupHealth | null): Promise<void> {
  const last = backup?.offsiteAt
    ? `O último comprovante chegou em ${formatSpDateTime(new Date(backup.offsiteAt))}.`
    : "O servidor não tem comprovante válido dessa cópia.";
  await raiseOperationalAlertOnce(
    `💾 Cópia do backup no computador atrasada\n${last} Há mais de 36 h o backup só existe na VPS.\n`
      + "👉 No Windows: tarefa \"AutomaBACA - Backup criptografado\" no Agendador de Tarefas, o last-attempt.json "
      + "da pasta dos backups e se ssh hermes funciona. O aviso fecha sozinho quando o comprovante chegar.",
    {
      source: SOURCE, key: "backup_offsite_stale", title: TITLES.backup_offsite_stale, risk: OperationalRisk.HIGH,
      evidence: { reason: "backup_offsite_stale", backup: backup?.state ?? null, offsiteAt: backup?.offsiteAt ?? null },
    },
  );
}

async function reportBackupFailed(backup: BackupHealth | null): Promise<void> {
  const failedAt = backup?.failedAt ? ` às ${formatSpDateTime(new Date(backup.failedAt))}` : "";
  await reportOperationalAction({
    source: SOURCE, key: "backup_failed", area: "incidentes", actionType: "incident.review",
    title: TITLES.backup_failed, priority: 80, risk: OperationalRisk.HIGH, incrementOccurrence: false,
    description: `A última execução do backup falhou${failedAt}. ${lastVerified(backup)} `
      + "O systemd tenta de novo 30 min depois, até 3 vezes por noite; se nenhuma der certo, o atraso chega pelo Telegram. "
      + "O motivo está em journalctl -u automabaca-novo-backup. O aviso fecha quando um backup conferido sair.",
    evidence: backupEvidence("backup_failed", backup),
  });
}

export async function checkLogArchiveHealth(): Promise<void> {
  if (!process.env.OBSERVABILITY_STATUS_DIR) return;
  const health = await readLogArchiveHealth();
  for (const reason of health.reasons) {
    if (reason === "backup_stale") { await reportBackupStale(health.backup); continue; }
    if (reason === "backup_failed") { await reportBackupFailed(health.backup); continue; }
    if (reason === "backup_offsite_stale") { await reportBackupOffsiteStale(health.backup); continue; }
    const offsite = reason.startsWith("offsite_");
    await reportOperationalAction({
      source: SOURCE, key: reason, area: "incidentes", actionType: "incident.review",
      title: TITLES[reason], priority: offsite ? 45 : 80, incrementOccurrence: false,
      description: offsite
        ? "Confira a tarefa de cópia de logs no Windows. O aviso fecha após o servidor receber um comprovante válido e recente."
        : "Confira a coleta e o armazenamento dos logs. O aviso fecha quando uma verificação recente confirmar a recuperação.",
      evidence: { reason, collection: health.collection, export: health.export, offsite: health.offsite },
    });
  }
  await reconcileOperationalActionSource(SOURCE, health.reasons);
}
