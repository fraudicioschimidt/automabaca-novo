import { canonicalizeTeamName, splitEventoTeams } from "@/src/domain/text";
import { canonicalSport } from "@/src/domain/sports/registry";
import { cardsForName, findTeamCardsByName } from "@/src/services/teams/resolve";
import { HOMONYM_PAIR_STRATEGY, LOCAL_IDENTITY_CANDIDATE_CONFIDENCE } from "./decision";
import type { SportCandidate } from "./types";

/**
 * Em que esporte os NOMES do evento existem, pelas fichas dos times (nome de
 * tipster confirmado, nome da Pinnacle17 com 2 jogos, nome do FlashScore), sem
 * depender do esporte inicialmente atribuído. É pista, nunca confirmação: clube
 * de futebol e de basquete dividem nome, e as fichas só conhecem os times que o
 * pareamento já viu. Todo candidato fica em `LOCAL_IDENTITY_CANDIDATE_CONFIDENCE`,
 * abaixo de 70: não confirma nem discorda, e confirma quem acha o jogo.
 */
export async function findTeamIdentitySportCandidates(
  evento: string,
  context?: { pais?: string; competicao?: string },
): Promise<SportCandidate[]> {
  const teams = splitEventoTeams(evento);
  if (!teams) return [];
  const homeNorm = canonicalizeTeamName(teams.home);
  const awayNorm = canonicalizeTeamName(teams.away);
  if (!homeNorm || !awayNorm) return [];

  const matches = await findTeamCardsByName([homeNorm, awayNorm], null);
  const scope = { pais: context?.pais ?? "", competicao: context?.competicao ?? "" };
  const candidates: SportCandidate[] = [];
  for (const sport of new Set(matches.map((match) => match.sport))) {
    const canonical = canonicalSport(sport);
    if (!canonical) continue;
    const inSport = matches.filter((match) => match.sport === sport);
    const [home, ...otherHomes] = cardsForName(teams.home, inSport, scope);
    const [away, ...otherAways] = cardsForName(teams.away, inSport, scope);
    if (!home || !away || otherHomes.length > 0 || otherAways.length > 0 || home.cardId === away.cardId) continue;
    candidates.push({
      sport: canonical,
      confidence: LOCAL_IDENTITY_CANDIDATE_CONFIDENCE,
      source: "TEAM_ID",
      provider: "team_identity",
      strategy: "team_cards",
    });
  }
  // O par completo em mais de um esporte é homônimo: os esportes do canal
  // escolhem (`channelPicksHomonym`), ou o FlashScore, ou o dono.
  if (candidates.length > 1) {
    return candidates.map((candidate) => ({ ...candidate, strategy: HOMONYM_PAIR_STRATEGY }));
  }
  return candidates;
}
