import { spDayKey, spStartOfTodayUtc } from "@/src/domain/dates";
import { canonicalCountry, KNOWN_COUNTRY_KEYS } from "@/src/domain/national-teams";
import { canonicalSport, type CanonicalSport } from "@/src/domain/sports/registry";
import { nationalTeamCountry } from "@/src/domain/team-alias-name";
import { isBaseCategoryFixture } from "@/src/domain/team-category";
import {
  canonicalizeTeamName,
  matchCanonTeamsWithCategoryContext,
  normalizeStr,
  teamCategoryInContext,
} from "@/src/domain/text";
import { canonicalizeFlashscoreTeamName } from "@/src/providers/flashscore/match";
import { flashscoreSportId } from "@/src/providers/flashscore/sports";
import type { FlashscoreCatalogMatch } from "@/src/providers/flashscore/types";
import { pinnacle17SportId, type Pinnacle17Event } from "@/src/providers/pinnacle17/types";

/**
 * O pareamento dos catálogos: cada jogo da Pinnacle17 com o do FlashScore, e
 * de cada lado bem casado a ficha do time (o id do FlashScore com o nome da
 * Pinnacle17). Decisão pura; quem busca os catálogos e grava é
 * `catalog-pairing-round.ts`.
 *
 * O critério é mais duro que o da liquidação, porque o par vale sem aposta que
 * o confirme: janela de 15 min, soma dos lados ≥ 1,5 com um lado âncora, 0,3 de
 * folga sobre qualquer outro jogo compatível na janela e o país coerente.
 */

/** Coletivos em que a Pinnacle17 e o FlashScore listam o mesmo jogo uma vez. Futebol sempre entra. */
const PAIRED_SPORTS = ["Soccer", "Basketball", "Hockey", "Volleyball", "Handball"] as const satisfies readonly CanonicalSport[];
const ALWAYS_PAIRED: CanonicalSport = "Soccer";

export const KICKOFF_WINDOW_MS = 15 * 60_000;
/** Métrica de cada rodada: a rodada grava, e o painel lê a última sem carregar os clientes dos fornecedores. */
export const CATALOG_PAIRING_METRIC = "teams.catalog_pairing";
const MIN_PAIR_SCORE = 1.5;
const MIN_MARGIN = 0.3;
/**
 * Evidência própria do lado, sem o resgate de digitação: o piso para o nome da
 * Pinnacle17 ir para a ficha e, em competição de região, para os dois lados
 * do par. A abreviação expandida do FlashScore ("I. Bratislava") vale 0,95.
 */
const MIN_SIDE_EVIDENCE = 0.85;
const DAY_MS = 86_400_000;
/** A rodada olha até o fim do dia de São Paulo ou 12 h à frente, o que for mais longe. */
const LOOKAHEAD_MS = 12 * 3_600_000;

/**
 * O país da competição que diz uma região, na macro-região dela: a Pinnacle17
 * e o FlashScore nomeiam a mesma confederação de jeitos diferentes.
 */
const MACRO_REGIONS: ReadonlyMap<string, string> = new Map(Object.entries({
  europe: ["europe", "uefa"],
  south_america: ["south america", "conmebol"],
  concacaf: ["north america", "central america", "north & central america", "caribbean", "concacaf"],
  asia: ["asia", "afc", "southeast asia", "east asia", "west asia", "central asia", "south asia"],
  africa: ["africa", "caf"],
  oceania: ["oceania", "australia & oceania", "ofc"],
  world: ["world", "international", "fifa"],
}).flatMap(([region, names]) => names.map((name) => [normalizeStr(name), region] as const)));
const WORLD = "world";
/**
 * O país que não diz onde o jogo é. "Americas" e "Latin America" cobrem duas
 * confederações, e o par não teria com o que se conferir.
 */
const UNKNOWN_TERRITORIES = new Set(["undefined", "unknown", "not specified", "americas", "latin america"]);

const FRIENDLY = /\b(?:friendl|amistos)/;
const CLUB_COMPETITION = /\bclubs?\b/;

export type CatalogSport = { sport: CanonicalSport; pinnacleSportId: number; flashscoreSportId: number };

/** Os esportes da rodada: futebol, e os outros coletivos da lista que tiveram aposta nos últimos 30 dias. */
export function catalogPairingSports(recentBetSports: readonly string[]): CatalogSport[] {
  const recent = new Set(recentBetSports.map((sport) => canonicalSport(sport)));
  return PAIRED_SPORTS.flatMap((sport) => {
    if (sport !== ALWAYS_PAIRED && !recent.has(sport)) return [];
    const pinnacleId = pinnacle17SportId(sport);
    const flashscoreId = flashscoreSportId(sport);
    return pinnacleId !== null && flashscoreId !== null
      ? [{ sport, pinnacleSportId: pinnacleId, flashscoreSportId: flashscoreId }]
      : [];
  });
}

export type CatalogWindow = { start: Date; end: Date };

/**
 * A janela da rodada: de agora até o fim do dia de São Paulo ou agora + 12 h,
 * o que for mais longe. A rodada das 20:37 pega a madrugada até as 08:37, e o
 * jogo da madrugada fica ligado antes de começar.
 */
export function pairingWindow(now: Date): CatalogWindow {
  const dayEnd = spStartOfTodayUtc(now).getTime() + DAY_MS;
  return { start: now, end: new Date(Math.max(dayEnd, now.getTime() + LOOKAHEAD_MS)) };
}

/** Um instante de cada dia UTC que a janela toca: a lista da Pinnacle17 é por dia UTC. */
export function pinnacleDaysOf(window: CatalogWindow): Date[] {
  const days: Date[] = [window.start];
  let next = Math.floor(window.start.getTime() / DAY_MS) * DAY_MS + DAY_MS;
  for (; next < window.end.getTime(); next += DAY_MS) days.push(new Date(next));
  return days;
}

/**
 * Os eventos da Pinnacle17 que o pareamento tenta: da janela, ainda não
 * começados, contados em tempo normal ("Regular": o tênis em sets, os cantos
 * e os cartões são outros eventos).
 */
export function pairablePinnacleEvents(events: readonly Pinnacle17Event[], window: CatalogWindow): Pinnacle17Event[] {
  const seen = new Set<number>();
  return events.filter((event) => {
    const kickoff = Date.parse(event.startTime);
    if (seen.has(event.id) || kickoff <= window.start.getTime() || kickoff >= window.end.getTime()) return false;
    seen.add(event.id);
    return event.units === "Regular"
      && !event.status.isStarted && !event.status.isInProgress && !event.status.isInterrupted;
  });
}

/** Os dias de São Paulo cujo catálogo do FlashScore cobre a janela de ±15 min do evento. */
export function flashscoreDaysOf(event: Pinnacle17Event): string[] {
  const kickoff = Date.parse(event.startTime);
  return [...new Set([spDayKey(new Date(kickoff - KICKOFF_WINDOW_MS)), spDayKey(new Date(kickoff + KICKOFF_WINDOW_MS))])];
}

/** Os dias de catálogo do FlashScore que a rodada precisa, em ordem. */
export function flashscoreDaysFor(events: readonly Pinnacle17Event[]): string[] {
  return [...new Set(events.flatMap(flashscoreDaysOf))].sort();
}

export type TeamCardCategory = "principal" | "reserva" | "feminino";

/** A categoria no vocabulário da ficha: o time feminino e o reserva têm id próprio no FlashScore. */
export function teamCardCategory(name: string, league: string | null | undefined): TeamCardCategory {
  const tokens = teamCategoryInContext(name, league);
  if (tokens.has("women") || tokens.has("w")) return "feminino";
  return tokens.size > 0 ? "reserva" : "principal";
}

/** O país da competição: um país (canônico), uma macro-região ou nada que diga onde. */
type Territory = { country: string } | { region: string } | null;

function territoryOf(raw: string | null | undefined): Territory {
  const key = normalizeStr((raw ?? "").trim());
  if (!key || UNKNOWN_TERRITORIES.has(key)) return null;
  const region = MACRO_REGIONS.get(key);
  return region ? { region } : { country: canonicalCountry((raw ?? "").trim()) };
}

/**
 * O país das duas competições concorda? `regional`: a mesma macro-região dos
 * dois lados, que não prende o nome a um país, e aí o par só vale com os dois
 * lados bem casados. Região de um lado e país do outro não se confere. Dois
 * países só conflitam se os dois estão na tabela fixa: a Pinnacle17 escreve
 * "Russian Federation" e o FlashScore, "Russia". Clube em competição mundial
 * é amistoso de pré-temporada: não liga.
 */
function territoryFit(pinnacle: Territory, flashscore: Territory, clubCompetition: boolean): "coherent" | "regional" | "refused" {
  if (!pinnacle || !flashscore) return "refused";
  if ("country" in pinnacle && "country" in flashscore) {
    const known = (country: string) => KNOWN_COUNTRY_KEYS.has(normalizeStr(country));
    return known(pinnacle.country) && known(flashscore.country) && pinnacle.country !== flashscore.country
      ? "refused" : "coherent";
  }
  if (!("region" in pinnacle) || !("region" in flashscore) || pinnacle.region !== flashscore.region) return "refused";
  return pinnacle.region === WORLD && clubCompetition ? "refused" : "regional";
}

/** País e liga da Pinnacle17 como chave da evidência. */
function leagueKeyOf(event: Pinnacle17Event): string {
  return `${normalizeStr(event.league.country ?? "")}|${normalizeStr(event.league.name)}`;
}

/** Um lado bem casado: o time do FlashScore e o nome que a Pinnacle17 usa para ele. */
export type CatalogCardSide = {
  flashscoreTeamId: string;
  flashscoreName: string;
  category: TeamCardCategory;
  country: string;
  pinnacleName: string;
  pinnacleNameNorm: string;
  pinnacleCategory: TeamCardCategory;
  leagueKey: string;
};

export type CatalogPair = {
  event: Pinnacle17Event;
  match: FlashscoreCatalogMatch;
  /** O mandante da Pinnacle17 é o visitante do FlashScore. */
  swapped: boolean;
  score: number;
  /** Os lados que ganham ficha; vazio em amistoso de clubes e em jogo de seleções. */
  cards: CatalogCardSide[];
};

export type CatalogMiss = "no_candidate" | "weak" | "ambiguous" | "country";

export type CatalogDecision =
  | { outcome: "paired"; pair: CatalogPair }
  | { outcome: "base" | CatalogMiss; event: Pinnacle17Event };

type ScoredCandidate = {
  match: FlashscoreCatalogMatch;
  home: string;
  away: string;
  result: ReturnType<typeof matchCanonTeamsWithCategoryContext>;
};

/**
 * O jogo do FlashScore do evento da Pinnacle17, entre as partidas dos
 * catálogos que cobrem a janela dele. Sem par, diz por quê: sem candidato na
 * janela, nomes fracos, empate com outro jogo compatível ou país incoerente.
 */
export function pairCatalogEvent(event: Pinnacle17Event, matches: readonly FlashscoreCatalogMatch[]): CatalogDecision {
  const league = event.league.name;
  if (isBaseCategoryFixture({ home: event.homeTeam.name, away: event.awayTeam.name, league })) {
    return { outcome: "base", event };
  }
  const kickoff = Date.parse(event.startTime);
  const betHome = canonicalizeTeamName(event.homeTeam.name);
  const betAway = canonicalizeTeamName(event.awayTeam.name);
  const near = matches.filter((match) =>
    Math.abs(match.timestamp * 1_000 - kickoff) <= KICKOFF_WINDOW_MS
    && !match.match_status.is_postponed && !match.match_status.is_cancelled
    && !isBaseCategoryFixture({ home: match.home_team.name, away: match.away_team.name, league: match.tournament.name }));
  if (near.length === 0) return { outcome: "no_candidate", event };

  const compatible: ScoredCandidate[] = near.flatMap((match) => {
    const home = canonicalizeFlashscoreTeamName(match.home_team.name);
    const away = canonicalizeFlashscoreTeamName(match.away_team.name);
    const result = matchCanonTeamsWithCategoryContext({
      betHome, betAway, fixtureHome: home, fixtureAway: away, betLeague: league, fixtureLeague: match.tournament.name,
    });
    return result.compatible ? [{ match, home, away, result }] : [];
  }).sort((a, b) => b.result.score - a.result.score || a.match.match_id.localeCompare(b.match.match_id));

  const best = compatible[0];
  if (!best || !best.result.anchored || best.result.score < MIN_PAIR_SCORE) return { outcome: "weak", event };
  const runnerUp = compatible[1];
  if (runnerUp && best.result.score - runnerUp.result.score < MIN_MARGIN) return { outcome: "ambiguous", event };

  const tournament = best.match.tournament.name;
  const pinnacleTerritory = territoryOf(event.league.country);
  const flashscoreTerritory = territoryOf(best.match.tournament.countryName);
  const fit = territoryFit(pinnacleTerritory, flashscoreTerritory, competitionSays(CLUB_COMPETITION, league, tournament));
  if (fit === "refused") return { outcome: "country", event };
  if (fit === "regional" && Math.min(best.result.evidenceHome, best.result.evidenceAway) < MIN_SIDE_EVIDENCE) {
    return { outcome: "weak", event };
  }

  // A tabela fixa de seleções só tira a ficha: o time dela é o país, não um clube.
  const nationalTeams = [event.homeTeam.name, event.awayTeam.name, best.home, best.away]
    .some((name) => nationalTeamCountry(name) !== null);
  const country = [pinnacleTerritory, flashscoreTerritory]
    .flatMap((territory) => (territory && "country" in territory ? [territory.country] : []))[0] ?? "";
  return {
    outcome: "paired",
    pair: {
      event,
      match: best.match,
      swapped: best.result.swapped,
      score: best.result.score,
      cards: nationalTeams || competitionSays(FRIENDLY, league, tournament) ? [] : cardSides(event, best, country),
    },
  };
}

/**
 * A liga da Pinnacle17 ou o torneio do FlashScore diz o padrão. Amistoso de
 * clubes ensina o jogo, não o time: o time pode ser de base ou de teste.
 */
function competitionSays(pattern: RegExp, pinnacleLeague: string, flashscoreTournament: string | null): boolean {
  return pattern.test(normalizeStr(pinnacleLeague)) || pattern.test(normalizeStr(flashscoreTournament ?? ""));
}

/** Os lados cuja evidência própria (sem o resgate de digitação) alcança o piso da ficha. */
function cardSides(event: Pinnacle17Event, best: ScoredCandidate, country: string): CatalogCardSide[] {
  const { match, result } = best;
  const pinnacleOf = (fixtureSide: "home" | "away") =>
    (fixtureSide === "home") !== result.swapped ? event.homeTeam.name : event.awayTeam.name;
  const sides = [
    { team: match.home_team, canon: best.home, evidence: result.evidenceHome, pinnacleName: pinnacleOf("home") },
    { team: match.away_team, canon: best.away, evidence: result.evidenceAway, pinnacleName: pinnacleOf("away") },
  ];
  return sides.flatMap((side) => side.evidence < MIN_SIDE_EVIDENCE || !side.team.team_id ? [] : [{
    flashscoreTeamId: side.team.team_id,
    flashscoreName: side.team.name,
    category: teamCardCategory(side.canon, match.tournament.name),
    country,
    pinnacleName: side.pinnacleName,
    pinnacleNameNorm: canonicalizeTeamName(side.pinnacleName),
    pinnacleCategory: teamCardCategory(side.pinnacleName, event.league.name),
    leagueKey: leagueKeyOf(event),
  }]);
}
