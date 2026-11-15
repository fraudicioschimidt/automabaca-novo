import { detectSportFromText, SPORT_AUTO_CONFIRM_MIN_CONFIDENCE } from "@/src/domain/sports/detect";
import { type CanonicalSport } from "@/src/domain/sports/registry";
import { guardIdentityCandidate, guardSoccerGameCandidate, sharedSoccerLeagueRefuted } from "@/src/services/bets/sport-resolution/capture";
import { findTeamIdentitySportCandidates } from "./team-candidates";
import { findBridgeSportCandidates } from "./bridge-candidate";
import { findFlashscoreSportCandidates } from "./flashscore-candidates";
import { findPinnacle17SportCandidates } from "./provider-candidates";
import { chooseSportCandidate, CONTRADICTED_STRATEGY_SUFFIX } from "./decision";
import type { SportSearchBet } from "./provider-shared";
import type { SportCandidate, SportSearchOptions } from "./types";

/**
 * Waterfall com fast-paths:
 * 0. Fast-path determinístico: vocabulário exclusivo de mercado/estatística/competição
 *    (a liga compartilhada que o post ou a linha desmentem não encerra)
 * 1. Fichas dos times (sub-segundo, sem rede): pista abaixo de 70, que não
 *    confirma nem segura outra fonte, mas orienta a busca nos catálogos. O
 *    esporte que o post, a linha ou o placar desmentem fica só no registro,
 *    sem voto.
 * 2. FlashScore (tier-1 externo com alta cota e cobertura ampla)
 * 3. Pinnacle17 (catálogo compartilhado)
 * 4. BridgeOdds (busca limitada, retomada em outro job quando faltar capacidade)
 * Nos catálogos, o jogo de futebol achado para uma linha que o futebol não
 * tem também fica só no registro.
 */
export async function collectSportCandidates(
  bet: SportSearchBet,
  hints: readonly CanonicalSport[],
  options: SportSearchOptions = {},
): Promise<SportCandidate[]> {
  const postSports = options.postSports ?? [];
  const scale = { ...bet, scores: options.postScores };
  // 0. Fast-path determinístico: vocabulário exclusivo de mercado / estatística / competição
  const deterministicText = [bet.competicao, bet.mercado, bet.selecao]
    .filter(Boolean)
    .join("\n");
  if (deterministicText) {
    const detected = detectSportFromText(deterministicText);
    if (
      detected.status === "CONFIRMED" &&
      detected.sport &&
      detected.confidence >= SPORT_AUTO_CONFIRM_MIN_CONFIDENCE &&
      !sharedSoccerLeagueRefuted(detected, scale, postSports)
    ) {
      return [
        {
          sport: detected.sport,
          confidence: detected.confidence,
          source: "TEXT",
          strategy: "deterministic_market_text",
        },
      ];
    }
  }

  // 1. Local: as fichas dos times. Casa os NOMES: o post, a linha e o placar
  // podem desmentir o esporte.
  const guard = (list: SportCandidate[]) => list.map((candidate) => guardIdentityCandidate(candidate, scale, postSports));
  const lines = [
    { mercado: bet.mercado ?? "", selecao: bet.selecao ?? "", evento: bet.evento },
    ...(options.readTerms ? [{ ...options.readTerms, evento: bet.evento }] : []),
  ];
  const guardGame = (list: SportCandidate[]) => list.map((candidate) => guardSoccerGameCandidate(candidate, lines));
  const identityCandidates = guard(await findTeamIdentitySportCandidates(bet.evento, {
    pais: bet.pais,
    competicao: bet.competicao,
  }));
  // A ficha não confirma, mas diz onde procurar o jogo: o esporte em que
  // os nomes existem, e que o post não desmente, entra nas pistas da busca
  // (handebol, futsal e rugby não são sondados sem pista).
  const searchHints = [...new Set([
    ...hints,
    ...identityCandidates.filter((candidate) => !candidate.strategy?.endsWith(CONTRADICTED_STRATEGY_SUFFIX))
      .map((candidate) => candidate.sport),
  ])];

  // 2. Provedor Tier-1: FlashScore
  const flashCandidates = guardGame(await findFlashscoreSportCandidates(bet, searchHints, options.now));
  const afterFlash = chooseSportCandidate([...identityCandidates, ...flashCandidates]);
  if (afterFlash.candidate || afterFlash.conflict) {
    return [...identityCandidates, ...flashCandidates];
  }

  // 3. Catálogo compartilhado antes da busca com cadência de 40 segundos.
  const pinnacleCandidates = guardGame(await findPinnacle17SportCandidates({ bet, hints: searchHints, flashCandidates }));
  const primaryCandidates = [...identityCandidates, ...flashCandidates, ...pinnacleCandidates];
  const primary = chooseSportCandidate(primaryCandidates);
  if (primary.candidate || primary.conflict) {
    return primaryCandidates;
  }

  const bridgeCandidates = guardGame(await findBridgeSportCandidates(bet, searchHints, options));
  return [
    ...primaryCandidates,
    ...bridgeCandidates,
  ];
}
