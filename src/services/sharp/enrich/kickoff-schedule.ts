import { looksLikeSpMidnightKickoff } from "@/src/domain/kickoff-infer";
import { spDayKey } from "@/src/domain/dates";
import { normalizeStr, splitEventoTeams } from "@/src/domain/text";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { bridgeConfigured } from "@/src/providers/bridgeodds/client";
import { findBridgeMatch } from "@/src/providers/bridgeodds/match";
import type { BridgeMatchCandidate } from "@/src/providers/bridgeodds/scoring";
import { bridgeSportFromEsporte } from "@/src/providers/bridgeodds/coverage-contract";
import { kickoffSanity } from "@/src/services/bets/sanity";
import { applyTeamAliases } from "./identity-cache";
import { autoMatchAmbiguous } from "./training-cases";

/**
 * Calendários que corrigem o kickoff provisório: a validação comum a todas as
 * fontes (janela em torno da âncora, sanidade, meia-noite SP) e o calendário
 * da BridgeOdds.
 */

const log = createLogger("kickoff-schedule");

/** Horário ausente usa o centro do dia de São Paulo, como o resolvedor de esporte. */
export function provisionalScheduleAnchor(anchor: Date): Date {
  return new Date(`${spDayKey(anchor)}T15:00:00.000Z`);
}

/** Aceita jogo até 1 dia antes da âncora (post atrasado) e 14 dias depois. */
const SCHEDULE_MAX_PAST_MS = 1 * 86_400_000;
const SCHEDULE_MAX_FUTURE_MS = 14 * 86_400_000;

/** A BridgeOdds só tem futebol e basquete no feed; os outros só gastariam cota. */
const BRIDGE_KICKOFF_SPORTS = new Set([
  "soccer",
  "football",
  "futebol",
  "basketball",
  "basquete",
]);

export function isBridgeKickoffSport(esporte: string): boolean {
  return BRIDGE_KICKOFF_SPORTS.has(esporte.trim().toLowerCase());
}

/** Valida o horário de um calendário contra a âncora, a sanidade e a meia-noite SP. */
export function acceptScheduleKickoff(
  kickoff: Date,
  anchor: Date,
): { ok: true } | { ok: false; reason: string } {
  if (Number.isNaN(kickoff.getTime())) {
    return { ok: false, reason: "invalid_date" };
  }
  const capped = kickoffSanity.safeParse(kickoff);
  if (!capped.success) {
    return { ok: false, reason: "sanity" };
  }
  const t = kickoff.getTime();
  const lo = anchor.getTime() - SCHEDULE_MAX_PAST_MS;
  const hi = anchor.getTime() + SCHEDULE_MAX_FUTURE_MS;
  if (t < lo || t > hi) {
    return { ok: false, reason: "out_of_window" };
  }
  if (looksLikeSpMidnightKickoff(kickoff)) {
    return { ok: false, reason: "still_midnight" };
  }
  return { ok: true };
}

/**
 * Rejeita ligas e participantes claramente de outra modalidade.
 */
export function pinnFixtureLooksWrongSport(
  esporte: string,
  league: string,
  home: string,
  away: string,
): boolean {
  const sport = normalizeStr(esporte);
  const blob = normalizeStr(`${league} ${home} ${away}`);
  if (sport === "volleyball") {
    return /\b(handball|handebol|haandbold|handbold)\b/.test(blob);
  }
  if (sport === "hockey") {
    return /\b(field hockey|floorball|hockey sobre grama)\b/.test(blob);
  }
  if (sport === "tennis") {
    return /\b(table tennis|ping.?pong|tenis de mesa)\b/.test(blob);
  }
  return false;
}

/**
 * O candidato de calendário que casa sozinho com o evento, dentro da janela
 * temporal da âncora: o mesmo piso e a mesma regra de empate do casamento
 * automático. Aqui não há juiz, então a zona cinzenta não dá horário.
 */
export function pickScheduleKickoff(
  candidates: BridgeMatchCandidate[],
  anchor: Date,
): BridgeMatchCandidate | null {
  const lo = anchor.getTime() - SCHEDULE_MAX_PAST_MS;
  const hi = anchor.getTime() + SCHEDULE_MAX_FUTURE_MS;
  const inWindow = candidates.filter((c) => {
    const t = new Date(c.match.match_date).getTime();
    return Number.isFinite(t) && t >= lo && t <= hi;
  });
  const best = [...inWindow].sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < getEnv().SHARP_AUTO_MATCH_MIN_SCORE) return null;
  return autoMatchAmbiguous(inWindow) ? null : best;
}

export type ResolveKickoffViaScheduleParams = {
  evento: string;
  esporte: string;
  pais?: string;
  competicao?: string;
  /** Âncora (postDate ou date-only). */
  data: Date;
  query?: Parameters<typeof findBridgeMatch>[0]["query"];
};

/**
 * Resolve kickoff provisório pelo calendário BridgeOdds (Pinnacle).
 * Não usa LLM — só o horário oficial do feed. Null = Bridge off, esporte
 * fora do contrato, times ilegíveis, ou match ambíguo.
 */
export async function resolveKickoffViaBridgeSchedule(
  bet: ResolveKickoffViaScheduleParams,
): Promise<Date | null> {
  if (!bridgeConfigured()) return null;
  if (!isBridgeKickoffSport(bet.esporte)) return null;
  const teams = splitEventoTeams(bet.evento);
  if (!teams) return null;
  const bridgeSport = bridgeSportFromEsporte(bet.esporte);
  if (!bridgeSport) return null;

  const aliased = await applyTeamAliases(
    teams,
    bet.esporte,
    bet.pais ?? "",
    bet.competicao ?? "",
  );

  // Janela econômica (dia e vizinhos): kickoff provisório pula o filtro ±2d.
  const found = await findBridgeMatch({
    home: aliased.home,
    away: aliased.away,
    bridgeSport,
    kickoffUtc: bet.data,
    skipKickoffWindow: true,
    kickoffInferido: true,
    query: bet.query,
    ...(bet.query ? {} : { maxSearchDurationMs: 5_000 }),
  });
  if (!found.ok) {
    log.info(
      { evento: bet.evento, reason: found.reason, n: found.candidates.length },
      "calendário BridgeOdds: sem candidato claro p/ kickoff",
    );
    return null;
  }

  const picked = pickScheduleKickoff(found.candidates, bet.data);
  if (!picked) {
    log.info({ evento: bet.evento }, "calendário BridgeOdds: candidatos ambíguos ou fora da janela");
    return null;
  }

  const kickoff = new Date(picked.match.match_date);
  if (Number.isNaN(kickoff.getTime())) return null;
  const capped = kickoffSanity.safeParse(kickoff);
  if (!capped.success) {
    log.warn({ evento: bet.evento, kickoff: kickoff.toISOString() }, "kickoff do calendário fora da sanidade");
    return null;
  }
  return capped.data;
}
