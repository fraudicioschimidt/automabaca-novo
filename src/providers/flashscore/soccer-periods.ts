import { z } from "zod";

/**
 * Placar por TEMPO no futebol, do endpoint `/matches/details`: o fornecedor
 * devolve `home_1st_half`/`away_1st_half` e `home_2nd_half`/`away_2nd_half` já
 * SEPARADOS (o segundo tempo não é acumulado). Serve para liquidar criar-aposta
 * com pernas de 1º e 2º tempo.
 *
 * Contrato estreito de propósito: só partida encerrada, nada ao vivo, e com a
 * ARITMÉTICA FECHANDO. Placar de tempo que não soma o total vira recusa.
 */
const gols = z.number().int().nonnegative().max(99);
const detailsSchema = z.object({
  match_id: z.string().min(1),
  sport: z.object({ sport_id: z.literal(1) }),
  match_status: z.object({
    stage: z.literal("Finished"),
    is_started: z.literal(true),
    is_finished: z.literal(true),
    is_in_progress: z.literal(false),
    is_cancelled: z.literal(false),
    is_postponed: z.literal(false),
    live_time: z.null(),
    live_minute: z.null(),
  }),
  scores: z.object({
    home: gols, away: gols,
    home_total: gols, away_total: gols,
    home_1st_half: gols, away_1st_half: gols,
    home_2nd_half: gols, away_2nd_half: gols,
    home_extra_time: gols.nullable(), away_extra_time: gols.nullable(),
  }),
});

export type SoccerPeriodScores = {
  matchId: string;
  /** Placar do 1º tempo. */
  ht: { home: number; away: number };
  /** Placar FEITO no 2º tempo, já separado pelo fornecedor. */
  sh: { home: number; away: number };
  /** Tempo regulamentar (1º + 2º), sem prorrogação. */
  regulation: { home: number; away: number };
};

/**
 * Parciais só quando o próprio fornecedor os declara e eles fecham com o total.
 *
 * A prorrogação entra na conta porque `home`/`away` a incluem: sem descontá-la,
 * um jogo decidido no tempo extra faria a soma dos dois tempos "não bater" e a
 * liquidação de 1º tempo seria recusada sem motivo.
 */
export function soccerPeriodScores(body: unknown, expected?: { matchId: string; score: { home: number; away: number } | null }): { ok: true; scores: SoccerPeriodScores } | { ok: false; reason: string } {
  const parsed = detailsSchema.safeParse(body);
  if (!parsed.success) return { ok: false, reason: "details_fora_do_contrato" };
  const s = parsed.data.scores;
  if (expected && (parsed.data.match_id !== expected.matchId || (expected.score
    && (s.home !== expected.score.home || s.away !== expected.score.away)))) {
    return { ok: false, reason: "partida_ou_placar_divergente" };
  }
  if (s.home !== s.home_total || s.away !== s.away_total) return { ok: false, reason: "total_divergente" };
  const extraHome = s.home_extra_time ?? 0;
  const extraAway = s.away_extra_time ?? 0;
  const regulationHome = s.home_total - extraHome;
  const regulationAway = s.away_total - extraAway;
  if (s.home_1st_half + s.home_2nd_half !== regulationHome
    || s.away_1st_half + s.away_2nd_half !== regulationAway) {
    return { ok: false, reason: "tempos_nao_somam_o_total" };
  }
  return {
    ok: true,
    scores: {
      matchId: parsed.data.match_id,
      ht: { home: s.home_1st_half, away: s.away_1st_half },
      sh: { home: s.home_2nd_half, away: s.away_2nd_half },
      regulation: { home: regulationHome, away: regulationAway },
    },
  };
}
