import { describe, expect, it } from "vitest";
import { ticketExceptionalLook, ticketObservationPersist } from "@/src/services/settlement/flashscore/ticket";

describe("ticketObservationPersist", () => {
  it("guarda o primeiro match_id real mesmo com um confronto ainda ao vivo", () => {
    expect(ticketObservationPersist([
      { matchId: "fs-fr", state: "score", terminal: true, score: { home: 2, away: 1 } },
      { matchId: "fs-es", state: "unresolved", terminal: false },
    ])).toEqual({
      matchId: "fs-fr",
      final: false,
      snapshot: {
        outcome: "matched",
        ticket: true,
        unfinished: true,
        fixtures: 2,
        scored: 1,
        cancelled: 0,
        postponedWaiting: 0,
        live: 1,
      },
    });
  });

  it("conta como ao vivo só o confronto casado e sem fim, não o que nem casou", () => {
    // O IA-Judge não liquida sozinho múltipla com jogo que o FlashScore ainda vê
    // rolando; a perna que ele não achou é justamente a que o juiz resolve.
    expect(ticketObservationPersist([
      { matchId: "fs-fr", state: "score", terminal: true, score: { home: 2, away: 1 } },
      { state: "unresolved", terminal: false },
    ]).snapshot).toMatchObject({ unfinished: true, live: 0 });
  });

  it("grava o placar lido de cada confronto casado, pelo match_id", () => {
    const desde = "2026-08-20T19:00:00.000Z";
    expect(ticketObservationPersist([
      { matchId: "fs-nyy", state: "unresolved", terminal: false, reading: { placar: "5x3", placarDesde: desde } },
      { matchId: "fs-chc", state: "score", terminal: true, score: { home: 2, away: 1 }, reading: { placar: "2x1", placarDesde: desde } },
      { state: "unresolved", terminal: false },
    ]).snapshot.placares).toEqual({
      "fs-nyy": { placar: "5x3", placarDesde: desde },
      "fs-chc": { placar: "2x1", placarDesde: desde },
    });
  });

  it("omite matchId quando nenhum confronto casou", () => {
    const persist = ticketObservationPersist([
      { state: "unresolved", terminal: false },
      { state: "unresolved", terminal: false },
    ]);
    expect(persist).toEqual({
      final: false,
      snapshot: {
        outcome: "no_candidate",
        ticket: true,
        unfinished: true,
        fixtures: 2,
        scored: 0,
        cancelled: 0,
        postponedWaiting: 0,
        live: 0,
      },
    });
    expect(persist).not.toHaveProperty("matchId");
  });

  it("só fecha quando todo confronto tem placar terminal", () => {
    expect(ticketObservationPersist([
      { matchId: "fs-fr", state: "score", terminal: true, score: { home: 2, away: 1 } },
      { matchId: "fs-es", state: "score", terminal: true, score: { home: 1, away: 0 } },
    ])).toMatchObject({ matchId: "fs-fr", final: true });
  });

  it("fecha cancelada e mantém adiada dentro da graça", () => {
    expect(ticketObservationPersist([
      { matchId: "fs-fr", state: "score", terminal: true, score: { home: 2, away: 1 } },
      { matchId: "fs-es", state: "cancelled", terminal: true },
    ])).toMatchObject({ final: true, snapshot: { unfinished: false, cancelled: 1 } });
    expect(ticketObservationPersist([
      { matchId: "fs-fr", state: "score", terminal: true, score: { home: 2, away: 1 } },
      { matchId: "fs-es", state: "postponed_waiting", terminal: false },
    ])).toMatchObject({ final: false, snapshot: { unfinished: true, postponedWaiting: 1 } });
  });

  it("fecha ausência terminal de placar para encaminhar revisão humana", () => {
    expect(ticketObservationPersist([
      { matchId: "fs-fr", state: "unresolved", terminal: true },
      { matchId: "fs-es", state: "cancelled", terminal: true },
    ])).toMatchObject({ final: true, snapshot: { unfinished: false } });
  });

  it("cancela imediatamente, mas respeita 48h de graça para jogo adiado", () => {
    const kickoff = new Date("2026-08-20T12:00:00Z");
    expect(ticketExceptionalLook({
      cancelled: true,
      postponed: false,
      kickoff,
      now: new Date("2026-08-20T13:00:00Z"),
    })).toEqual({ state: "cancelled", terminal: true });
    expect(ticketExceptionalLook({
      cancelled: false,
      postponed: true,
      kickoff,
      now: new Date("2026-08-22T11:59:59Z"),
    })).toEqual({ state: "postponed_waiting", terminal: false });
    expect(ticketExceptionalLook({
      cancelled: false,
      postponed: true,
      kickoff,
      now: new Date("2026-08-22T12:00:00Z"),
    })).toEqual({ state: "cancelled", terminal: true });
  });
});
