import { validateCaptureStakeSettings, type CaptureStakeSettings, type CaptureStakeSnapshot } from "./capture-stake-policy";

export type DurableCaptureStakeSnapshot = CaptureStakeSnapshot & { basis: "CAPTURE" };

/** JSON persistido continua sendo dado: uma versão ausente/inválida não vira MESSAGE. */
export function readDurableCaptureStakeSnapshot(value: unknown): DurableCaptureStakeSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<DurableCaptureStakeSnapshot>;
  if (row.version !== 1 || row.basis !== "CAPTURE" ||
      !["MESSAGE", "WHEN_MISSING", "ALWAYS"].includes(row.stakePolicy ?? "") ||
      !["message", "bankroll_default", "bankroll_fixed"].includes(row.source ?? "") ||
      !(row.originalStake === null || (typeof row.originalStake === "number" && Number.isFinite(row.originalStake))) ||
      row.defaultStakeUnits === undefined) return null;
  try {
    validateCaptureStakeSettings(row);
    return row as DurableCaptureStakeSnapshot;
  } catch { return null; }
}

export function preserveCaptureStakeSnapshot(parsed: unknown): DurableCaptureStakeSnapshot | null {
  if (!parsed || typeof parsed !== "object" || !("stakePolicySnapshot" in parsed)) return null;
  const snapshot = parsed.stakePolicySnapshot;
  return snapshot && typeof snapshot === "object" ? readDurableCaptureStakeSnapshot({ ...snapshot, basis: "CAPTURE" }) : null;
}

export function historicalStakeSettings(row: { captureStakeSnapshot?: unknown }): CaptureStakeSettings | undefined {
  // Só o snapshot gravado com a aposta conta: a evidência da captura expira, e
  // NULL (aposta manual, captura sem política) não autoriza deduzir uma política.
  const durable = readDurableCaptureStakeSnapshot(row.captureStakeSnapshot);
  return durable ? validateCaptureStakeSettings(durable) : undefined;
}

/** Mesmo contrato na prévia da edição, nos lotes e na escrita transacional. */
export function resolveFinancialEditValues(
  row: { stake: unknown; odds: unknown; captureStakeSnapshot?: unknown; manualStakeOverride?: boolean; manualOddsOverride?: boolean },
  incoming: { stake: number; odds: number },
  authority: "operator" | "system",
): { stake: number; odds: number } {
  if (authority === "operator") return incoming;
  return {
    stake: row.manualStakeOverride ? Number(row.stake) : incoming.stake,
    odds: row.manualOddsOverride ? Number(row.odds) : incoming.odds,
  };
}
