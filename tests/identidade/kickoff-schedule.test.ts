import { describe, expect, it } from "vitest";
import {
  acceptScheduleKickoff,
  isBridgeKickoffSport,
  pickScheduleKickoff,
  pinnFixtureLooksWrongSport,
} from "@/src/services/sharp/enrich/kickoff-schedule";
import type { BridgeMatchCandidate } from "@/src/providers/bridgeodds/scoring";
import type { BridgeMatch } from "@/src/providers/bridgeodds/types";

function cand(
  over: Partial<BridgeMatch> & { score: number; match_date: string },
): BridgeMatchCandidate {
  return {
    score: over.score,
    swapped: false,
    match: {
      match_id: over.match_id ?? Math.floor(Math.random() * 1e9),
      home: over.home ?? "Home",
      away: over.away ?? "Away",
      sport: "Futebol",
      league: "Test",
      match_date: over.match_date,
      home_score: null,
      away_score: null,
    },
  };
}

describe("pickScheduleKickoff", () => {
  const anchor = new Date("2026-06-10T15:00:00Z");

  it("escolhe o melhor score dentro da janela", () => {
    const picked = pickScheduleKickoff(
      [
        cand({ score: 1.2, match_date: "2026-06-12T21:00:00Z", match_id: 1 }),
        cand({ score: 1.8, match_date: "2026-06-11T19:00:00Z", match_id: 2 }),
      ],
      anchor,
    );
    expect(picked?.match.match_id).toBe(2);
  });

  it("rejeita empate textual ambíguo", () => {
    const picked = pickScheduleKickoff(
      [
        cand({ score: 1.7, match_date: "2026-06-11T19:00:00Z", match_id: 1 }),
        cand({ score: 1.62, match_date: "2026-06-12T19:00:00Z", match_id: 2 }),
      ],
      anchor,
    );
    expect(picked).toBeNull();
  });

  it("ignora fora da janela (±1d passado / +14d futuro)", () => {
    const picked = pickScheduleKickoff(
      [
        cand({ score: 2.0, match_date: "2026-05-01T19:00:00Z", match_id: 1 }),
        cand({ score: 1.6, match_date: "2026-06-11T19:00:00Z", match_id: 2 }),
      ],
      anchor,
    );
    expect(picked?.match.match_id).toBe(2);
  });

  it("não dá horário de candidato da zona cinzenta, que só o juiz decidiria", () => {
    // "Atletico-GO vs Vila Nova" contra "Atletico MG vs Nova Iguacu" pontua 0,90.
    expect(
      pickScheduleKickoff(
        [cand({ score: 0.9, match_date: "2026-06-11T19:00:00Z", match_id: 1 })],
        anchor,
      ),
    ).toBeNull();
    expect(
      pickScheduleKickoff(
        [cand({ score: 1.49, match_date: "2026-06-11T19:00:00Z", match_id: 1 })],
        anchor,
      ),
    ).toBeNull();
  });

  it("abaixo do piso → null", () => {
    expect(
      pickScheduleKickoff(
        [cand({ score: 0.5, match_date: "2026-06-11T19:00:00Z", match_id: 1 })],
        anchor,
      ),
    ).toBeNull();
  });
});

describe("isBridgeKickoffSport", () => {
  it("aceita Soccer/Basketball", () => {
    expect(isBridgeKickoffSport("Soccer")).toBe(true);
    expect(isBridgeKickoffSport("Futebol")).toBe(true);
    expect(isBridgeKickoffSport("Basketball")).toBe(true);
    expect(isBridgeKickoffSport("Basquete")).toBe(true);
  });

  it("rejeita Tennis/Hockey/Volleyball", () => {
    expect(isBridgeKickoffSport("Tennis")).toBe(false);
    expect(isBridgeKickoffSport("Hockey")).toBe(false);
    expect(isBridgeKickoffSport("Volleyball")).toBe(false);
    expect(isBridgeKickoffSport("Baseball")).toBe(false);
  });
});

describe("pinnFixtureLooksWrongSport", () => {
  it("rejeita volleyball feed que parece handball", () => {
    expect(
      pinnFixtureLooksWrongSport(
        "Volleyball",
        "Handball - Champions League",
        "Team A",
        "Team B",
      ),
    ).toBe(true);
  });

  it("aceita volleyball limpo", () => {
    expect(
      pinnFixtureLooksWrongSport("Volleyball", "Brazil - Superliga", "Sesi", "Minas"),
    ).toBe(false);
  });
});

describe("acceptScheduleKickoff", () => {
  const anchor = new Date("2026-07-31T15:00:00Z");

  it("aceita horário na janela", () => {
    expect(acceptScheduleKickoff(new Date("2026-07-31T18:00:00Z"), anchor).ok).toBe(true);
  });

  it("rejeita meia-noite SP", () => {
    // 03:00Z = meia-noite America/Sao_Paulo (sem DST)
    expect(acceptScheduleKickoff(new Date("2026-08-01T03:00:00Z"), anchor).ok).toBe(false);
  });
});
