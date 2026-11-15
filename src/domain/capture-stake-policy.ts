import { MAX_STAKE_UNIDADES_CAPTURA } from "./bet-capture";

export const CAPTURE_STAKE_POLICIES = ["MESSAGE", "WHEN_MISSING", "ALWAYS"] as const;
export type CaptureStakePolicy = typeof CAPTURE_STAKE_POLICIES[number];
export type CaptureStakeSettings = { stakePolicy?: CaptureStakePolicy; defaultStakeUnits?: number | null };
export type CaptureStakeSnapshot = {
  version: 1;
  stakePolicy: CaptureStakePolicy;
  defaultStakeUnits: number | null;
  originalStake: number | null;
  source: "message" | "bankroll_default" | "bankroll_fixed";
};

export function validateCaptureStakeSettings(settings: CaptureStakeSettings): Required<CaptureStakeSettings> {
  const stakePolicy = settings.stakePolicy ?? "MESSAGE";
  const defaultStakeUnits = settings.defaultStakeUnits ?? null;
  if (!CAPTURE_STAKE_POLICIES.includes(stakePolicy)) throw new Error("Política de stake inválida.");
  if (defaultStakeUnits !== null && (!Number.isFinite(defaultStakeUnits) || defaultStakeUnits <= 0 || defaultStakeUnits > MAX_STAKE_UNIDADES_CAPTURA || Math.round(defaultStakeUnits * 1e6) / 1e6 !== defaultStakeUnits)) {
    throw new Error("Stake padrão deve ser maior que zero, até 100u e ter no máximo seis casas decimais.");
  }
  if (stakePolicy !== "MESSAGE" && defaultStakeUnits === null) throw new Error("Informe a stake padrão em unidades.");
  return { stakePolicy, defaultStakeUnits };
}

export function resolveCaptureStake(original: number | null | undefined, settings?: CaptureStakeSettings, options?: { zeroIsMissing?: boolean }): { stake: number | null; snapshot?: CaptureStakeSnapshot } {
  if (!settings) return { stake: original ?? null };
  const policy = validateCaptureStakeSettings(settings);
  // A missing/omitted LLM number is zero. Negative and other invalid explicit
  // numbers remain errors under WHEN_MISSING; they are not absence evidence.
  const missing = original === undefined || original === null || (original === 0 && options?.zeroIsMissing === true);
  const forced = policy.stakePolicy === "ALWAYS";
  const fallback = policy.stakePolicy === "WHEN_MISSING" && missing;
  return {
    stake: forced || fallback ? policy.defaultStakeUnits : original ?? null,
    snapshot: { version: 1, ...policy, originalStake: original ?? null, source: forced ? "bankroll_fixed" : fallback ? "bankroll_default" : "message" },
  };
}
