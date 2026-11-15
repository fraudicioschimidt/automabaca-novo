import { describe, expect, it } from "vitest";
import { toBet } from "@/app/_design/adapters/aposta";
import { betRowToExportInput } from "@/src/services/painel/bet-export-map";
import type { BetRowData } from "@/src/domain/bet-read-model";

function row(over: Partial<BetRowData> = {}): BetRowData {
  return {
    id: "live",
    data: new Date("2026-08-12T20:00:00Z"),
    evento: "Time A vs Time B",
    competicao: "Liga",
    pais: "BR",
    esporte: "Soccer",
    mercado: "Handicap – Match",
    selecao: "Time B +0.25",
    liveScoreHome: null,
    liveScoreAway: null,
    casaDeAposta: "Bet365",
    tipster: "Canal",
    odds: 2,
    stake: 1,
    status: "PENDING",
    lucro: 0,
    closingOdd: null,
    openingMaxBet: null,
    closingMaxBet: null,
    openingOdd: null,
    openingRawOdd: null,
    closingRawOdd: null,
    registradoEm: new Date("2026-08-12T17:00:00Z"),
    clv: null,
    clvReliable: null,
    identityStatus: null,
    noOddsReason: null,
    closingNoOddsReason: null,
    source: "telegram-channel:-1",
    sourceExternalId: "1",
    contaTitular: null,
    ...over,
  };
}

describe("placar live em materialidade e readers", () => {
  // A captura só grava o 0-0 com texto que o confirme; a legenda expira em 30
  // dias, e o par gravado é o que a liquidação usa.
  it("ficha e CSV mostram o par gravado, 0-0 inclusive", () => {
    const zeroZero = row({ liveScoreHome: 0, liveScoreAway: 0 });
    expect(toBet(zeroZero).d.liveScoreAtTip).toBe("0-0");
    expect(betRowToExportInput(zeroZero).scoreAtTip).toBe("0-0");
    expect(toBet(row()).d.liveScoreAtTip).toBeNull();
    expect(betRowToExportInput(row()).scoreAtTip).toBe("");
  });
});
