export type MonitoramentoState = "healthy" | "degraded" | "unavailable";
export type ChannelMonitoramentoState = "healthy" | "degraded" | "unknown";

export type MonitoramentoSummary = {
  available: boolean;
  healthy: boolean | null;
  state: MonitoramentoState;
  engineState: MonitoramentoState;
  jobsState: MonitoramentoState;
  channelsState: MonitoramentoState;
  actionableTotal: number | null;
  degradedChannelTotal: number | null;
  sloBreachTotal: number | null;
};


export function channelMonitoramentoState(input: {
  parse: number | null;
  identity: number | null;
  preKickoffFailures: number;
  transientFailures: number;
  /** Canal calado além do próprio ritmo (vigia de silêncio). */
  silent?: boolean;
  /** Captura pausada pelo dono: sem post lido, a falta de amostra é esperada. */
  paused?: boolean;
}): ChannelMonitoramentoState {
  if (input.silent || input.preKickoffFailures > 0 || input.transientFailures > 0) return "degraded";
  const sampled = [input.parse, input.identity]
    .filter((value): value is number => value != null);
  if (sampled.length === 0) return input.paused ? "healthy" : "unknown";
  return sampled.some((value) => value < 90) ? "degraded" : "healthy";
}

export function deriveMonitoramentoSummary(input: {
  available: boolean;
  workerOk: boolean;
  bancoOk: boolean;
  closingOk: boolean;
  jobsAvailable: boolean;
  jobFailureTotal: number;
  openActions: number;
  ackedActions: number;
  sloBreachTotal: number;
  channelStates: ChannelMonitoramentoState[];
  orphanChannelTotal: number;
}): MonitoramentoSummary {
  if (!input.available) {
    return {
      available: false,
      healthy: null,
      state: "unavailable",
      engineState: "unavailable",
      jobsState: "unavailable",
      channelsState: "unavailable",
      actionableTotal: null,
      degradedChannelTotal: null,
      sloBreachTotal: null,
    };
  }

  const actionableTotal = input.openActions + input.ackedActions;
  const degradedChannelTotal = input.channelStates.filter((state) => state === "degraded").length
    + input.orphanChannelTotal;
  const engineState = input.workerOk && input.bancoOk && input.closingOk
    ? "healthy"
    : "degraded";
  const jobsState = !input.jobsAvailable
    ? "unavailable"
    : input.jobFailureTotal > 0 ? "degraded" : "healthy";
  const channelsState = degradedChannelTotal > 0
    ? "degraded"
    : input.channelStates.some((state) => state === "unknown")
      ? "unavailable"
      : "healthy";
  const degraded = engineState !== "healthy"
    || jobsState !== "healthy"
    || channelsState !== "healthy"
    || actionableTotal > 0
    || input.sloBreachTotal > 0;
  return {
    available: true,
    healthy: !degraded,
    state: degraded ? "degraded" : "healthy",
    engineState,
    jobsState,
    channelsState,
    actionableTotal,
    degradedChannelTotal,
    sloBreachTotal: input.sloBreachTotal,
  };
}
