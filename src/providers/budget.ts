import type { Prisma } from "@/src/generated/prisma/client";
import { createLogger } from "@/src/infra/logger";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { prisma } from "@/src/infra/prisma";
import { spDayKey } from "@/src/domain/dates";
import {
  BudgetExhaustedError,
  ProviderBudgetAccountingError,
} from "@/src/domain/provider-error";
import { findProviderCap, periodKeyFor } from "@/src/providers/budget-config";
import { PINNACLE17_DAILY_OPERATIONAL_CAP } from "@/src/providers/pinnacle17/limits";

/**
 * Orçamento de providers: consumo atômico em `provider_budgets`, no Postgres,
 * para valer entre restarts, web e worker. Nenhum contador em memória decide
 * gasto. Cada provider tem período (mês, dia ou hora) e teto com margem sob o
 * limite contratado (`PROVIDER_CAPS`).
 */

const log = createLogger("provider-budget");
const warnedExhaustedPeriods = new Set<string>();

function warnExhaustedOnce(
  provider: string,
  periodKey: string,
  details: Record<string, unknown>,
  message: string,
): void {
  const key = `${provider}:${periodKey}`;
  if (warnedExhaustedPeriods.has(key)) return;
  // Poda só chaves de outros períodos: apagar a do período corrente engoliria
  // o aviso de um esgotamento em andamento.
  if (warnedExhaustedPeriods.size >= 256) {
    for (const antiga of warnedExhaustedPeriods) {
      if (!antiga.endsWith(`:${periodKey}`)) warnedExhaustedPeriods.delete(antiga);
    }
    if (warnedExhaustedPeriods.size >= 256) warnedExhaustedPeriods.clear();
  }
  warnedExhaustedPeriods.add(key);
  log.warn(
    { eventCode: LOG_EVENTS.PROVIDER_BUDGET_EXHAUSTED, provider, periodKey, ...details },
    message,
  );
}

/**
 * Espera antes de gastar UMA chamada para reaprender a janela de um provider
 * cujo `spent` reconciliado ficou acima do teto sem `windowResetAt` conhecido.
 * Uma hora limita o bloqueio autoinfligido e custa no máximo 24 chamadas por
 * dia se o fornecedor estiver mesmo esgotado.
 */
const SONDA_SEM_JANELA_MS = 60 * 60_000;

/**
 * Reserva atômica de `cost` unidades do período corrente do provider.
 * false = budget esgotado (caller pula o provider sem erro).
 */
export async function consumeProviderBudget(
  provider: string,
  cost: number,
  now = new Date(),
): Promise<boolean> {
  const cap = findProviderCap(provider);
  if (!cap) throw new Error(`Provider sem cap configurado: ${provider}`);
  if (!Number.isFinite(cap.cap)) return true; // ilimitado — não rastreia
  const periodKey = periodKeyFor(cap.period, now);
  // O INSERT de um período novo não passa pelo WHERE do ON CONFLICT.
  if (cost > cap.cap) {
    warnExhaustedOnce(provider, periodKey, { cost, cap: cap.cap }, "custo unico acima do teto — recusado");
    return false;
  }
  const sondaLiberadaApos = new Date(now.getTime() - SONDA_SEM_JANELA_MS);
  // Três caminhos para a reserva passar; os dois últimos existem porque o
  // nosso período não é o do fornecedor (ver `reconcileProviderBudgetFromProvider`):
  // 1. cabe no teto;
  // 2. a janela do fornecedor virou (`windowResetAt` passou): o gasto RECOMEÇA
  //    em `cost`, porque ele recomeçou a contar;
  // 3. `spent` acima do teto sem janela conhecida, o que só a reconciliação
  //    produz. Uma sonda por `SONDA_SEM_JANELA_MS` passa para reaprender a
  //    janela; ela SOMA ao gasto (zerar reabriria a cota local inteira).
  // `${now}` em vez de `now()` do Postgres: a `periodKey` veio do relógio do
  // chamador, e a mesma decisão não pode consultar dois relógios.
  const updated = await prisma.$executeRaw`
    INSERT INTO "provider_budgets" ("provider", "periodKey", "spent", "reserved", "updatedAt")
    VALUES (${provider}, ${periodKey}, ${cost}, 0, ${now})
    ON CONFLICT ("provider", "periodKey")
    DO UPDATE SET
      "spent" = CASE
        WHEN "provider_budgets"."windowResetAt" IS NOT NULL
             AND "provider_budgets"."windowResetAt" <= ${now}::timestamptz
          THEN ${cost}
        ELSE "provider_budgets"."spent" + ${cost}
      END,
      "windowResetAt" = CASE
        WHEN "provider_budgets"."windowResetAt" <= ${now}::timestamptz THEN NULL
        ELSE "provider_budgets"."windowResetAt"
      END,
      "updatedAt" = ${now}
    WHERE ("provider_budgets"."windowResetAt" IS NOT NULL
           AND "provider_budgets"."windowResetAt" <= ${now}::timestamptz)
       OR ("provider_budgets"."windowResetAt" IS NULL
           AND "provider_budgets"."spent" > ${cap.cap}
           AND "provider_budgets"."updatedAt" <= ${sondaLiberadaApos}::timestamptz)
       OR "provider_budgets"."spent" + "provider_budgets"."reserved" + ${cost} <= ${cap.cap}
  `;
  if (updated === 0) {
    warnExhaustedOnce(provider, periodKey, { cost }, "budget do periodo esgotado — provider pulado");
    return false;
  }
  return true;
}

/** Hook para `fetchJsonWithRetry.beforeAttempt`: uma unidade por request física. */
export async function chargeProviderRequest(
  provider: string,
  requestLabel?: string,
): Promise<void> {
  let allowed: boolean;
  try {
    allowed = await consumeProviderBudget(provider, 1);
  } catch (cause) {
    throw new ProviderBudgetAccountingError(provider, requestLabel, cause);
  }
  if (!allowed) {
    throw new BudgetExhaustedError(provider, requestLabel);
  }
}

/**
 * Reconcilia o gasto com a cota informada pelo provider. Dentro da mesma janela
 * o gasto só aumenta; uma janela nova permite reiniciá-lo. `windowResetAt`
 * também permite retomar consultas quando o contador anterior estava esgotado.
 */
export async function reconcileProviderBudgetFromProvider(
  provider: string,
  remaining: number,
  resetEmSegundos: number | null = null,
  now = new Date(),
): Promise<void> {
  const cap = findProviderCap(provider);
  if (!cap || !Number.isFinite(cap.cap)) return;
  if (!Number.isFinite(remaining) || remaining < 0) return;
  const gastoReal = Math.max(0, cap.contracted - remaining);
  const periodKey = periodKeyFor(cap.period, now);
  const resetAt =
    resetEmSegundos !== null && Number.isFinite(resetEmSegundos) && resetEmSegundos > 0
      ? new Date(now.getTime() + resetEmSegundos * 1_000)
      : null;
  await prisma.$executeRaw`
    INSERT INTO "provider_budgets" ("provider", "periodKey", "spent", "reserved", "updatedAt", "windowResetAt")
    VALUES (${provider}, ${periodKey}, ${gastoReal}, 0, ${now}, ${resetAt})
    ON CONFLICT ("provider", "periodKey")
    DO UPDATE SET
      "spent" = CASE
        WHEN ${resetAt}::timestamptz IS NULL
          THEN GREATEST("provider_budgets"."spent", ${gastoReal})
        WHEN "provider_budgets"."windowResetAt" IS NULL
          THEN ${gastoReal}
        WHEN abs(extract(epoch FROM ("provider_budgets"."windowResetAt" - ${resetAt}::timestamptz))) <= 300
          THEN GREATEST("provider_budgets"."spent", ${gastoReal})
        ELSE ${gastoReal}
      END,
      "windowResetAt" = COALESCE(${resetAt}::timestamptz, "provider_budgets"."windowResetAt"),
      "updatedAt" = ${now}
  `;
}

/**
 * Cobra uma consulta extra da série de fechamento: primeiro o teto diário dela,
 * depois 80% do teto da Pinnacle17, na mesma linha que chamadas e reservas
 * normais disputam. Sem a sonda de quota desconhecida do fluxo principal.
 * Deve rodar na transação da tentativa: o rollback desfaz as duas cobranças.
 */
export async function chargeClosingSeriesBudget(
  tx: Prisma.TransactionClient,
  now: Date,
  dailyCap: number,
): Promise<void> {
  const day = spDayKey(now);
  const ceiling = Math.floor(PINNACLE17_DAILY_OPERATIONAL_CAP * 0.8);
  await tx.closingPriceBudget.upsert({ where: { day }, create: { day, updatedAt: now }, update: {} });
  const charged = await tx.closingPriceBudget.updateMany({
    where: { day, spent: { lt: dailyCap } },
    data: { spent: { increment: 1 }, updatedAt: now },
  });
  if (!charged.count) throw new BudgetExhaustedError("pinnacle17", "closing-series-daily-cap");
  await tx.$executeRaw`INSERT INTO provider_budgets (provider, "periodKey", spent, reserved, "updatedAt")
    VALUES ('pinnacle17', ${day}, 0, 0, ${now}) ON CONFLICT (provider, "periodKey") DO NOTHING`;
  const allowed = await tx.$executeRaw`UPDATE provider_budgets SET
    spent = CASE WHEN "windowResetAt" IS NOT NULL AND "windowResetAt" <= ${now} THEN 1 ELSE spent + 1 END,
    "windowResetAt" = CASE WHEN "windowResetAt" <= ${now} THEN NULL ELSE "windowResetAt" END, "updatedAt" = ${now}
    WHERE provider = 'pinnacle17' AND "periodKey" = ${day}
      AND CASE WHEN "windowResetAt" IS NOT NULL AND "windowResetAt" <= ${now}
        THEN reserved + 1 ELSE spent + reserved + 1 END <= ${ceiling}`;
  if (!allowed) throw new BudgetExhaustedError("pinnacle17", "closing-series-normal-headroom");
}
