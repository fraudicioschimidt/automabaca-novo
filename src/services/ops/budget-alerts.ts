import { persistOperationalAlert, sendOperationalAlert } from "@/src/services/ops/alerts";
import { OperationalRisk } from "@/src/generated/prisma/client";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { PROVIDER_CAPS, periodKeyFor } from "@/src/providers/budget-config";
import { reconcileOperationalActionSource } from "@/src/services/ops/operational-actions";

const log = createLogger("budget-alerts");

/**
 * Alerta de budget por provider (≥85% warn, ≥100% critical).
 * Chamado pelo ciclo de closing (a cada 5 min, só no worker). Dedupe DURÁVEL por
 * (provider, período, nível) via AuditEvent — alerta uma vez por período,
 * sobrevive a restart.
 */

const WARN_PCT = 85;

export async function checkProviderBudgetAlerts(now = new Date()): Promise<void> {
  const activeKeys: string[] = [];
  for (const cap of PROVIDER_CAPS) {
    if (!Number.isFinite(cap.cap)) continue;
    const periodKey = periodKeyFor(cap.period, now);
    const row = await prisma.providerBudget.findUnique({
      where: { provider_periodKey: { provider: cap.provider, periodKey } },
      select: { spent: true, reserved: true },
    });
    const spent = row?.spent ?? 0;
    const reserved = row?.reserved ?? 0;
    const committed = spent + reserved;
    const pct = (committed / cap.cap) * 100;
    const budgetLevel = pct >= 100 ? "critical" : pct >= WARN_PCT ? "warn" : null;
    if (!budgetLevel) continue;
    const incidentKey = `${cap.provider}:${periodKey}:${budgetLevel}`;
    activeKeys.push(incidentKey);

    const resourceId = `${periodKey}:${budgetLevel}`;
    const emoji = budgetLevel === "critical" ? "🛑" : "⚠️";
    const message =
      `${emoji} Cota de ${cap.provider} ${budgetLevel === "critical" ? "esgotada" : "quase no fim"}\n` +
      `Usado ${committed} de ${cap.cap} (${Math.round(pct)}%) no período ${periodKey}.` +
      (budgetLevel === "critical" ? "\nEle fica de fora até o período virar."
        : "\nEm 100% ele fica de fora até o período virar. Se for um pico pontual, nada a fazer.");
    const context = {
      source: "budget",
      key: incidentKey,
      title: `Cota ${cap.provider} em ${Math.round(pct)}%`,
      risk: budgetLevel === "critical" ? OperationalRisk.CRITICAL : OperationalRisk.MEDIUM,
      resource: "provider",
      resourceId: cap.provider,
      evidence: { periodKey, spent, reserved, committed, cap: cap.cap, pct: Math.round(pct), level: budgetLevel },
    };
    const ja = await prisma.auditEvent.findFirst({
      where: { action: "budget_alert", resource: cap.provider, resourceId },
      select: { id: true },
    });
    if (ja) {
      await persistOperationalAlert(message, context, { incrementOccurrence: false });
      continue;
    }

    await prisma.auditEvent.create({
      data: {
        action: "budget_alert",
        resource: cap.provider,
        resourceId,
        details: { spent, reserved, committed, cap: cap.cap, pct: Math.round(pct) },
      },
    });
    const telegramDelivered = await sendOperationalAlert(message, context);
    log.warn(
      {
        provider: cap.provider,
        periodKey,
        spent,
        reserved,
        committed,
        cap: cap.cap,
        budgetLevel,
        telegramDelivered,
      },
      "incidente de budget registrado",
    );
  }
  await reconcileOperationalActionSource("budget", activeKeys, now);
}
