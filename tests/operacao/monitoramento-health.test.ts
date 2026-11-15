import { describe, expect, it } from "vitest";
import {
  channelMonitoramentoState,
  deriveMonitoramentoSummary,
} from "@/src/domain/monitoramento-health";

describe("contrato tri-state do Monitoramento", () => {
  it("não converte ausência de leitura em saúde nem em zero", () => {
    expect(deriveMonitoramentoSummary({
      available: false,
      workerOk: false,
      bancoOk: false,
      closingOk: false,
      jobsAvailable: false,
      jobFailureTotal: 0,
      openActions: 0,
      ackedActions: 0,
      sloBreachTotal: 0,
      channelStates: [],
      orphanChannelTotal: 0,
    })).toEqual({
      available: false,
      healthy: null,
      state: "unavailable",
      engineState: "unavailable",
      jobsState: "unavailable",
      channelsState: "unavailable",
      actionableTotal: null,
      degradedChannelTotal: null,
      sloBreachTotal: null,
    });
  });

  it("inclui closing, OPEN+ACKED e canais degradados no resumo canônico", () => {
    expect(deriveMonitoramentoSummary({
      available: true,
      workerOk: true,
      bancoOk: true,
      closingOk: false,
      jobsAvailable: true,
      jobFailureTotal: 0,
      openActions: 6,
      ackedActions: 2,
      sloBreachTotal: 0,
      channelStates: ["healthy", "degraded", "unknown"],
      orphanChannelTotal: 3,
    })).toMatchObject({
      healthy: false,
      state: "degraded",
      engineState: "degraded",
      actionableTotal: 8,
      degradedChannelTotal: 4,
    });
  });

  it("canal pausado pelo dono sem amostra não é leitura faltando; falha dele ainda degrada", () => {
    const pausado = { parse: null, identity: null, preKickoffFailures: 0, transientFailures: 0, paused: true };
    expect(channelMonitoramentoState(pausado)).toBe("healthy");
    expect(channelMonitoramentoState({ ...pausado, transientFailures: 1 })).toBe("degraded");
  });

  it("taxa nula permanece desconhecida; falha transitória degrada", () => {
    expect(channelMonitoramentoState({
      parse: null,
      identity: null,
      preKickoffFailures: 0,
      transientFailures: 0,
    })).toBe("unknown");
    expect(channelMonitoramentoState({
      parse: 100,
      identity: 100,
      preKickoffFailures: 0,
      transientFailures: 1,
    })).toBe("degraded");
  });
});
