export const TEAM_PROVIDERS = {
  PINNACLE: "PINNACLE",
  BRIDGEODDS: "BRIDGEODDS",
  FLASHSCORE: "FLASHSCORE",
  PINNACLE17: "PINNACLE17",
} as const;

export type TeamProvider = (typeof TEAM_PROVIDERS)[keyof typeof TEAM_PROVIDERS];

export type TeamIdentityContext = {
  sport: string;
  pais: string;
  competicao: string;
};

/** Por qual nome a ficha do time foi achada. */
export type TeamCardRoute = "tipster_name" | "pinnacle_name" | "flashscore_name";

export type TeamResolutionStrategy =
  | TeamCardRoute
  /** Ficha achada, mas sem nome do provider que sirva: nome de entrada mantido. */
  | "card_only"
  /** FlashScore sem ficha: busca pela tradução Pinnacle (seleções nacionais). */
  | "pinnacle_translation"
  | "original"
  /** Mais de uma ficha para o nome, ou a mesma ficha nos dois lados: não traduz. */
  | "ambiguous";

export type ResolvedProviderTeam = {
  inputName: string;
  resolvedName: string;
  cardId: string | null;
  /** Id do time no FlashScore, só quando o alvo é o FlashScore. É dica, não filtro. */
  providerTeamId: string | null;
  strategy: TeamResolutionStrategy;
  /**
   * Outros nomes da mesma ficha, em ordem de preferência: segunda tentativa de
   * busca no provider antes de declarar miss.
   */
  alternativeNames: string[];
};

/** Resolução que NÃO traduziu o nome de entrada (com ou sem ficha). */
export function manteveNomeDeEntrada(resolution: ResolvedProviderTeam): boolean {
  return resolution.strategy === "original"
    || resolution.strategy === "card_only"
    || resolution.strategy === "ambiguous";
}

export type ResolvedTeamsForProvider = {
  home: string;
  away: string;
  homeResolution: ResolvedProviderTeam;
  awayResolution: ResolvedProviderTeam;
};
