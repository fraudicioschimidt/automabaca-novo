import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import { translateNationalTeamPtToEn } from "@/src/domain/national-teams";
import { canonicalizeTeamName, normalizeStr } from "@/src/domain/text";
import { resolveTeamsForProvider } from "@/src/services/teams/resolve";
import { TEAM_PROVIDERS, type ResolvedProviderTeam, type ResolvedTeamsForProvider } from "@/src/services/teams/types";

type AliasedTeams = {
  home: string;
  away: string;
  homeResolution: ResolvedProviderTeam;
  awayResolution: ResolvedProviderTeam;
};

/**
 * Traduz nomes locais → Pinnacle ANTES da busca no provider, pelas fichas dos
 * times (`resolveTeamsForProvider`) e, sem ficha, pelo mapa fixo de seleções
 * nacionais PT→EN. Nome com mais de uma ficha não traduz.
 */
export async function applyTeamAliases(
  teams: { home: string; away: string },
  sport: string,
  pais: string,
  competicao: string,
  /** `false` só compara nomes (a deduplicação): não conta a cobertura. */
  options: { recordUse?: boolean } = {},
): Promise<AliasedTeams> {
  const resolved = await resolveTeamsForProvider(teams, TEAM_PROVIDERS.PINNACLE, {
    sport,
    pais,
    competicao,
  });
  return pinnacleTeamsFrom(teams, resolved, sport, options);
}

/**
 * A tradução Pinnacle de uma resolução já feita (`resolveTeamsForProviders`),
 * com o mapa fixo de seleções no lado que a ficha não traduziu.
 */
export async function pinnacleTeamsFrom(
  teams: { home: string; away: string },
  resolved: ResolvedTeamsForProvider,
  sport: string,
  options: { recordUse?: boolean } = {},
): Promise<AliasedTeams> {
  if (options.recordUse ?? true) await recordTranslationCoverage(sport, resolved);
  const result: AliasedTeams = {
    home: resolved.home,
    away: resolved.away,
    homeResolution: resolved.homeResolution,
    awayResolution: resolved.awayResolution,
  };
  for (const side of ["home", "away"] as const) {
    // O mapa estático vem dos feeds de futebol. Fora de Soccer, nomes como
    // Franca (clube de basquete) não provam que se trata da seleção France.
    if (result[side] === teams[side] && normalizeStr(sport) === "soccer") {
      const nacional = translateNationalTeamPtToEn(teams[side]);
      if (nacional && canonicalizeTeamName(nacional) !== canonicalizeTeamName(teams[side])) {
        result[side] = nacional;
      }
    }
  }
  return result;
}

/**
 * Quanto as fichas estão de fato traduzindo. Sem isto uma queda de cobertura
 * só apareceria como aumento de casos de treino.
 */
async function recordTranslationCoverage(sport: string, resolved: ResolvedTeamsForProvider): Promise<void> {
  await recordOperationalMetric({
    kind: "action",
    name: "team_alias.apply",
    outcome: "success",
    labels: {
      provider: TEAM_PROVIDERS.PINNACLE,
      sport,
      home: resolved.homeResolution.strategy,
      away: resolved.awayResolution.strategy,
      identities:
        Number(Boolean(resolved.homeResolution.cardId)) +
        Number(Boolean(resolved.awayResolution.cardId)),
    },
  });
}
