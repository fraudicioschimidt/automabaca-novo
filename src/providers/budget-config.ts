import { spDayKey } from "@/src/domain/dates";
import type { PeriodoDeCusto } from "@/src/domain/rendimento-de-provider";
import {
  BRIDGEODDS_CONTRACTED_REQUESTS_PER_HOUR,
  BRIDGEODDS_OPERATIONAL_REQUESTS_PER_HOUR,
} from "@/src/providers/bridgeodds/limits";
import {
  FLASHSCORE_DAILY_CONTRACTED_REQUESTS,
  FLASHSCORE_DAILY_OPERATIONAL_CAP,
  FLASHSCORE_PLAN_NAME,
} from "@/src/providers/flashscore/limits";
import {
  PINNACLE17_DAILY_CONTRACTED_REQUESTS,
  PINNACLE17_DAILY_OPERATIONAL_CAP,
  PINNACLE17_DIAGNOSTIC_RESERVE,
  PINNACLE17_PLAN_NAME,
} from "@/src/providers/pinnacle17/limits";

/**
 * O período do teto. A definição mora no domínio porque a TELA também precisa
 * dela para dizer em palavras a janela do gasto ("nesta hora", "hoje").
 */
type BudgetPeriod = PeriodoDeCusto;

type ProviderCap = {
  provider: string;
  period: BudgetPeriod;
  cap: number;
  contracted: number;
  label: string;
};

export const PROVIDER_CAPS: readonly ProviderCap[] = [
  {
    provider: "bridgeodds",
    period: "hour",
    cap: BRIDGEODDS_OPERATIONAL_REQUESTS_PER_HOUR,
    contracted: BRIDGEODDS_CONTRACTED_REQUESTS_PER_HOUR,
    label: `${BRIDGEODDS_OPERATIONAL_REQUESTS_PER_HOUR}/h (margem sob teto efetivo medido de ${BRIDGEODDS_CONTRACTED_REQUESTS_PER_HOUR}/h)`,
  },
  {
    provider: "pinnacle17",
    period: "day",
    cap: PINNACLE17_DAILY_OPERATIONAL_CAP,
    contracted: PINNACLE17_DAILY_CONTRACTED_REQUESTS,
    label: `${PINNACLE17_DAILY_OPERATIONAL_CAP}/dia (${PINNACLE17_PLAN_NAME} ${PINNACLE17_DAILY_CONTRACTED_REQUESTS}/dia; reserva ${PINNACLE17_DIAGNOSTIC_RESERVE})`,
  },
  {
    provider: "flashscore",
    period: "day",
    cap: FLASHSCORE_DAILY_OPERATIONAL_CAP,
    contracted: FLASHSCORE_DAILY_CONTRACTED_REQUESTS,
    label: `9.500/dia (${FLASHSCORE_PLAN_NAME} 10.000/dia; reserva 500)`,
  },
] as const;

export function findProviderCap(provider: string): ProviderCap | undefined {
  return PROVIDER_CAPS.find((cap) => cap.provider === provider);
}

export function periodKeyFor(period: BudgetPeriod, now = new Date()): string {
  if (period === "day") return spDayKey(now);
  if (period === "hour") return now.toISOString().slice(0, 13);
  return now.toISOString().slice(0, 7);
}
