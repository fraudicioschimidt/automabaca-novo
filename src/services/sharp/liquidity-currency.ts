import { getEnv, type Env } from "@/src/infra/env";

export type SharpLiquidityProvider = "bridgeodds" | "pinnacle17";

/**
 * Moeda do limite somente quando declarada pelo operador a partir do contrato
 * do provider. As APIs atuais expõem o número, mas BridgeOdds/Pinnacle17 não
 * declaram sua unidade na resposta; assumir USD aqui fabricaria liquidez.
 */
export function maxBetCurrencyForProvider(
  provider: string | null | undefined,
  env: Env = getEnv(),
): string | null {
  switch (provider?.trim().toLowerCase() as SharpLiquidityProvider | undefined) {
    case "bridgeodds":
      return env.BRIDGEODDS_MAX_BET_CURRENCY ?? null;
    case "pinnacle17":
      return env.PINNACLE17_MAX_BET_CURRENCY ?? null;
    default:
      return null;
  }
}
