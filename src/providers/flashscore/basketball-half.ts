import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@/src/domain/canonical-json";
import type { FlashscoreMatchCandidate } from "./match";

const points = z.number().int().nonnegative().max(1_000);
const detailsSchema = z.object({
  match_id: z.string().min(1), timestamp: z.number().int().positive(),
  sport: z.object({ sport_id: z.literal(3) }),
  home_team: z.object({ team_id: z.string().min(1) }),
  away_team: z.object({ team_id: z.string().min(1) }),
  match_status: z.object({ stage: z.literal("Finished"), is_started: z.literal(true),
    is_finished: z.literal(true), is_in_progress: z.literal(false),
    is_cancelled: z.literal(false), is_postponed: z.literal(false),
    is_finished_after_extra_time: z.boolean(), is_finished_after_penalties: z.literal(false),
    live_time: z.null(), live_minute: z.null() }),
  scores: z.object({ home: points, away: points, home_total: points, away_total: points,
    home_1st_quarter: points, away_1st_quarter: points,
    home_2nd_quarter: points, away_2nd_quarter: points,
    home_3rd_quarter: points, away_3rd_quarter: points,
    home_4th_quarter: points, away_4th_quarter: points,
    home_overtime: points.nullable(), away_overtime: points.nullable(),
    home_1st_half: points.nullish(), away_1st_half: points.nullish() }),
});

export type BasketballHalfProof = {
  version: 1; provider: "flashscore"; endpoint: "/matches/details";
  period: "HT"; requestStartedAt: string; observedAt: string;
  payloadSha256: string; matchId: string; swapped: boolean;
  score: { home: number; away: number };
  quarters: Array<{ home: number; away: number }>;
  details: z.infer<typeof detailsSchema>;
};

/** Reconstitui o período usando somente campos explícitos e concordantes do fornecedor. */
export function verifyBasketballHalfDetails(params: {
  body: unknown; candidate: FlashscoreMatchCandidate; requestStartedAt: string; observedAt: string;
  now: Date;
}): { ok: true; proof: BasketballHalfProof } | { ok: false; reason: string } {
  const parsed = detailsSchema.safeParse(params.body);
  if (!parsed.success) return { ok: false, reason: "missing_or_invalid_period_details" };
  const d = parsed.data, m = params.candidate.match;
  const started = Date.parse(params.requestStartedAt), observed = Date.parse(params.observedAt);
  if (!Number.isFinite(started) || !Number.isFinite(observed) || started > observed
    || observed > params.now.getTime() + 30_000 || params.now.getTime() - observed > 5 * 60_000
    || started < m.timestamp * 1_000) return { ok: false, reason: "invalid_observation_time" };
  // O timestamp de details difere do kickoff da listagem.
  // Conservá-lo como dado bruto; identidade vem de match_id e dos dois team_id.
  if (d.match_id !== m.match_id
    || d.home_team.team_id !== m.home_team.team_id || d.away_team.team_id !== m.away_team.team_id
    || d.home_team.team_id === d.away_team.team_id) return { ok: false, reason: "identity_conflict" };
  if (!m.match_status.is_finished || m.match_status.is_in_progress || !m.match_status.is_started
    || m.match_status.is_cancelled || m.match_status.is_postponed
    || m.match_status.is_finished_after_penalties === true
    || (m.match_status.is_finished_after_extra_time !== undefined
      && m.match_status.is_finished_after_extra_time !== d.match_status.is_finished_after_extra_time)) {
    return { ok: false, reason: "final_status_conflict" };
  }
  const s = d.scores;
  const quarters = [
    { home: s.home_1st_quarter, away: s.away_1st_quarter },
    { home: s.home_2nd_quarter, away: s.away_2nd_quarter },
    { home: s.home_3rd_quarter, away: s.away_3rd_quarter },
    { home: s.home_4th_quarter, away: s.away_4th_quarter },
  ];
  const regulation = quarters.reduce((sum, q) => ({ home: sum.home + q.home, away: sum.away + q.away }), { home: 0, away: 0 });
  const overtime = d.match_status.is_finished_after_extra_time;
  if (overtime ? s.home_overtime === null || s.away_overtime === null || regulation.home !== regulation.away
    : (s.home_overtime !== null && s.home_overtime !== 0) || (s.away_overtime !== null && s.away_overtime !== 0)) {
    return { ok: false, reason: "overtime_conflict" };
  }
  if (regulation.home + (s.home_overtime ?? 0) !== s.home_total
    || regulation.away + (s.away_overtime ?? 0) !== s.away_total
    || s.home !== s.home_total || s.away !== s.away_total
    || m.scores.home !== s.home_total || m.scores.away !== s.away_total) {
    return { ok: false, reason: "period_total_conflict" };
  }
  const half = { home: s.home_1st_quarter + s.home_2nd_quarter, away: s.away_1st_quarter + s.away_2nd_quarter };
  if ((s.home_1st_half != null && s.home_1st_half !== half.home)
    || (s.away_1st_half != null && s.away_1st_half !== half.away)) return { ok: false, reason: "half_total_conflict" };
  const orient = (p: { home: number; away: number }) => params.candidate.swapped ? { home: p.away, away: p.home } : p;
  return { ok: true, proof: { version: 1, provider: "flashscore", endpoint: "/matches/details", period: "HT",
    requestStartedAt: params.requestStartedAt, observedAt: params.observedAt,
    payloadSha256: createHash("sha256").update(canonicalJson(d)).digest("hex"),
    matchId: d.match_id, swapped: params.candidate.swapped, score: orient(half), quarters: quarters.map(orient), details: d } };
}
