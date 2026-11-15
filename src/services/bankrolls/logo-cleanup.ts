import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { deleteLogoFiles, logoOwnerKey, withLogoOwnership } from "@/src/services/logos/storage";

const log = createLogger("bankroll-logo-cleanup");
const SLUG = /^[a-z0-9-]+$/;

type BankrollDeleteAuditDetails = {
  logoSlugs?: unknown;
};

function logoSlugsFromDetails(details: unknown): string[] {
  const raw = (details as BankrollDeleteAuditDetails | null)?.logoSlugs;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Audit de exclusão de banca sem logoSlugs válido.");
  }
  const slugs = raw.filter((slug): slug is string => typeof slug === "string" && SLUG.test(slug));
  if (slugs.length !== raw.length) {
    throw new Error("Audit de exclusão de banca contém slug de logo inválido.");
  }
  return [...new Set(slugs)];
}

/** Limpa a logo indicada pelo resumo/outbox e confirma o efeito no Postgres. */
type LogoCleanupDeps = { deleteLogo?: (slug: string) => Promise<void> };

export async function dispatchBankrollLogoCleanupAudit(
  auditId: string,
  deps: LogoCleanupDeps = {},
): Promise<boolean> {
  const audit = await prisma.auditEvent.findFirst({
    where: { id: auditId, action: "bankroll.delete", outcome: "pending" },
    select: { id: true, resourceId: true, details: true },
  });
  if (!audit) return false;

  if (!audit.resourceId) throw new Error("Limpeza de logo sem dono da exclusão.");
  for (const slug of logoSlugsFromDetails(audit.details)) {
    await (deps.deleteLogo ?? deleteLogoFiles)(logoOwnerKey(slug, audit.resourceId));
    // Logos anteriores ao armazenamento por id continuam legíveis. Só são
    // apagadas se ninguém reutilizou o slug. As novas nunca usam esse caminho.
    await withLogoOwnership(slug, null, () => (deps.deleteLogo ?? deleteLogoFiles)(slug));
  }
  await prisma.auditEvent.updateMany({
    where: { id: audit.id, action: "bankroll.delete", outcome: "pending" },
    data: { outcome: "success" },
  });
  return true;
}

/**
 * Fast-path pós-commit. Falha não transforma um hard-delete confirmado em
 * erro para a UI: o AuditEvent continua `pending` e o worker retoma.
 */
export async function tryDispatchBankrollLogoCleanupAudit(
  auditId: string,
  deps: LogoCleanupDeps = {},
): Promise<boolean> {
  try {
    return await dispatchBankrollLogoCleanupAudit(auditId, deps);
  } catch (err) {
    log.warn({ err, auditId }, "limpeza de logo persistida para retry");
    return false;
  }
}

/** Repescagem periódica; erros sobem depois do lote para retry/dead-letter. */
export async function dispatchPendingBankrollLogoCleanups(): Promise<number> {
  const pending = await prisma.auditEvent.findMany({
    where: { action: "bankroll.delete", outcome: "pending" },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { id: true },
  });
  let dispatched = 0;
  const errors: unknown[] = [];
  for (const row of pending) {
    try {
      if (await dispatchBankrollLogoCleanupAudit(row.id)) dispatched += 1;
    } catch (err) {
      errors.push(err);
      log.error({ err, auditId: row.id }, "outbox de logo segue pendente");
    }
  }
  if (errors.length > 0) throw errors[0];
  return dispatched;
}
