import { describe, expect, it } from "vitest";
import { isHistoricalIdentityRecovery } from "@/src/services/sharp/enrich/historical-identity";

describe("isHistoricalIdentityRecovery — tolerância de enriquecimento pré-kickoff", () => {
  const KICKOFF = new Date("2026-09-01T15:00:00Z");

  it("partida futura não é recuperação histórica", () => {
    const now = new Date("2026-09-01T14:50:00Z");
    const bet = {
      id: "b1",
      data: KICKOFF,
      registradoEm: new Date("2026-09-01T14:45:00Z"),
      sharp: { identityStatus: "PENDING" },
    };
    expect(isHistoricalIdentityRecovery(bet, now)).toBe(false);
  });

  it("tip registrada antes do kickoff tem tolerância de até 5 minutos pós-kickoff", () => {
    const bet = {
      id: "b2",
      data: KICKOFF,
      registradoEm: new Date("2026-09-01T14:58:00Z"), // 2min antes do kickoff
      sharp: { identityStatus: "PENDING" },
    };

    // 2 minutos pós-kickoff (dentro da janela de 5 min) -> NÃO é recuperação histórica
    const now2MinPost = new Date("2026-09-01T15:02:00Z");
    expect(isHistoricalIdentityRecovery(bet, now2MinPost)).toBe(false);

    // 5 minutos pós-kickoff (no limite exato) -> NÃO é recuperação histórica
    const now5MinPost = new Date("2026-09-01T15:05:00Z");
    expect(isHistoricalIdentityRecovery(bet, now5MinPost)).toBe(false);

    // 5 minutos e 1 segundo pós-kickoff -> É recuperação histórica
    const nowPastGrace = new Date("2026-09-01T15:05:01Z");
    expect(isHistoricalIdentityRecovery(bet, nowPastGrace)).toBe(true);

    // 15 minutos pós-kickoff -> É recuperação histórica
    const now15MinPost = new Date("2026-09-01T15:15:00Z");
    expect(isHistoricalIdentityRecovery(bet, now15MinPost)).toBe(true);
  });

  it("tip registrada após o kickoff não tem tolerância de 5 min", () => {
    const bet = {
      id: "b3",
      data: KICKOFF,
      registradoEm: new Date("2026-09-01T15:01:00Z"), // 1min após kickoff
      sharp: { identityStatus: "PENDING" },
    };

    // 2 minutos pós-kickoff -> já é recuperação histórica imediatamente
    const now2MinPost = new Date("2026-09-01T15:02:00Z");
    expect(isHistoricalIdentityRecovery(bet, now2MinPost)).toBe(true);
  });

  it("identidade já MATCHED ou MANUAL não entra em recuperação histórica", () => {
    const now = new Date("2026-09-01T15:10:00Z");
    const betMatched = {
      id: "b4",
      data: KICKOFF,
      registradoEm: new Date("2026-09-01T14:30:00Z"),
      sharp: { identityStatus: "MATCHED" },
    };
    expect(isHistoricalIdentityRecovery(betMatched, now)).toBe(false);
  });

  it("evento além da janela de 30 dias é ignorado", () => {
    const oldKickoff = new Date("2026-07-01T12:00:00Z");
    const now = new Date("2026-09-01T12:00:00Z");
    const bet = {
      id: "b5",
      data: oldKickoff,
      registradoEm: new Date("2026-07-01T11:00:00Z"),
      sharp: { identityStatus: "PENDING" },
    };
    expect(isHistoricalIdentityRecovery(bet, now)).toBe(false);
  });
});
