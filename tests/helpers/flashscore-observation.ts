/**
 * Dados de partida e aposta compartilhados pelos testes que rodam
 * `runFlashscoreObservationOnce` de ponta a ponta. Só dados: os `vi.mock` ficam
 * em cada arquivo de teste, porque o Vitest os iça por arquivo.
 */

export const now = new Date("2026-07-22T22:00:00Z");
export const kickoff = new Date("2026-07-22T18:00:00Z");

export const bet = {
  id: "bet-1",
  evento: "Athletic Club vs Operario Ferroviario",
  esporte: "Soccer",
  competicao: "Serie B",
  pais: "Brazil",
  mercado: "Total – Match",
  selecao: "Under 5.5",
  odds: 1.67,
  stake: 1,
  status: "PENDING",
  data: kickoff,
  registradoEm: new Date("2026-07-22T16:00:00Z"),
  kickoffInferido: false,
  liveScoreHome: null,
  liveScoreAway: null,
  legsJson: null,
  captureEvidence: null,
  sharp: null,
  closing: null,
};

/** Resposta de `listFlashscoreMatchesByDate` com a partida de `bet` encerrada em 2x3. */
export const group = [{
  matches: [{
    match_id: "fs-1",
    timestamp: Math.floor(kickoff.getTime() / 1_000),
    home_team: { team_id: "h", name: "Athletic Club" },
    away_team: { team_id: "a", name: "Operario Ferroviario" },
    scores: { home: 2, away: 3 },
    match_status: {
      stage: "Finished",
      is_cancelled: false,
      is_postponed: false,
      is_started: true,
      is_in_progress: false,
      is_finished: true,
    },
  }],
}];
