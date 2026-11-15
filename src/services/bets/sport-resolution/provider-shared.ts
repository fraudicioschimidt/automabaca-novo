import { teamCategoryConflictInContext } from "@/src/domain/text";

export type SportSearchBet = {
  evento: string;
  data: Date;
  kickoffInferido?: boolean;
  pais: string;
  competicao: string;
  mercado?: string;
  selecao?: string;
};

/**
 * Os times do provider, já orientados, são da categoria dos da aposta? A
 * categoria que as competições explicam vale: "Hapoel Jerusalem F" na liga
 * feminina é o "Hapoel Jerusalem" da "Premier League Women" da Pinnacle.
 */
export function providerTeamCategoryCompatible(params: {
  localHome: string;
  localAway: string;
  providerHome: string;
  providerAway: string;
  swapped: boolean;
  betLeague?: string | null;
  providerLeague?: string | null;
}): boolean {
  const expectedHome = params.swapped ? params.localAway : params.localHome;
  const expectedAway = params.swapped ? params.localHome : params.localAway;
  const leagues = { betLeague: params.betLeague, fixtureLeague: params.providerLeague };
  return (
    !teamCategoryConflictInContext({ betName: expectedHome, fixtureName: params.providerHome, ...leagues }) &&
    !teamCategoryConflictInContext({ betName: expectedAway, fixtureName: params.providerAway, ...leagues })
  );
}
