import { shiftDayKey } from "@/src/domain/dates";
import {
  canonicalizeTeamName,
  sameTeamCategory,
  teamCategoryInContext,
  teamSimilarityCanon,
} from "@/src/domain/text";
import { CircuitOpenError } from "@/src/infra/circuit-breaker";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import { FlashscoreDateWindowError } from "@/src/providers/flashscore/date-window";
import {
  findFlashscoreMatch,
  findFlashscoreMatchByStrictNames,
  flashscoreMatchCrossesCategory,
  flashscoreTeamIdsListed,
  type FindFlashscoreMatchResult,
  type FlashscoreMatchCandidate,
} from "@/src/providers/flashscore/match";
import type { FlashscoreMatch } from "@/src/providers/flashscore/types";
import { pinnacleTeamsFrom } from "@/src/services/sharp/enrich/identity-cache";
import { findUsableCatalogLink } from "@/src/services/teams/catalog-links";
import { resolveTeamsForProviders } from "@/src/services/teams/resolve";
import {
  manteveNomeDeEntrada,
  TEAM_PROVIDERS,
  type ResolvedProviderTeam,
  type ResolvedTeamsForProvider,
} from "@/src/services/teams/types";

/**
 * Qual partida do FlashScore é o jogo da aposta: o jogo já vinculado, o jogo
 * ligado pelo pareamento dos catálogos ao evento da identidade, ou a busca no
 * catálogo do dia (e nos vizinhos) pelos nomes que as fichas traduzem.
 *
 * As fichas e a ligação só ajudam a casar: traduzem o nome, dão o id do time e
 * apontam o jogo. Nome ambíguo não traduz, e ligação que as travas recusam cai
 * para a busca por nome; quem decide a partida são as travas de nome, horário e
 * categoria.
 */

const log = createLogger("flashscore-candidate");

export type LoadFlashscoreMatches = (sportId: number, day: string) => Promise<FlashscoreMatch[] | null>;

type IdentityBet = {
  esporte: string;
  pais: string;
  competicao: string;
  data: Date;
};

export type FlashscoreIdentitySearch = {
  resolved: ResolvedTeamsForProvider;
  searchTeams: { home: string; away: string };
  expectedTeamIds: { home: string | null; away: string | null };
  /** O nome cru da aposta e as outras grafias da ficha, por lado. */
  alternatives: { home: string[]; away: string[] };
};

/** De onde veio o jogo casado: o vínculo anterior, a ligação dos catálogos ou a busca. */
export type FlashscoreMatchSource = "result_match" | "catalog_link" | "search";

function isCircuitOpen(error: unknown): boolean {
  return error instanceof CircuitOpenError
    || (error instanceof Error && error.name === "CircuitOpenError");
}

/**
 * Jogos perto da meia-noite podem cair no catálogo do dia vizinho. Visita os
 * dias -1 e +1 até `visit` devolver um resultado; dia fora do horizonte do
 * provider é pulado, e breaker aberto encerra a busca sem martelar o outro dia.
 */
async function searchAdjacentDays<T>(
  params: { sportId: number; day: string; loadMatches: LoadFlashscoreMatches },
  visit: (matches: FlashscoreMatch[]) => T | null,
  failure: { message: string; fields?: Record<string, unknown> },
): Promise<T | null> {
  for (const offset of [-1, 1]) {
    const adjacentDay = shiftDayKey(params.day, offset);
    try {
      const adjacent = await params.loadMatches(params.sportId, adjacentDay);
      if (!adjacent) continue;
      const found = visit(adjacent);
      if (found !== null) return found;
    } catch (error) {
      if (error instanceof FlashscoreDateWindowError) continue;
      if (isCircuitOpen(error)) break;
      log.warn(
        { err: error, day: adjacentDay, sportId: params.sportId, ...failure.fields },
        failure.message,
      );
    }
  }
  return null;
}

/**
 * O dia vizinho que falhou já foi avisado: as outras passadas da mesma busca
 * (pelos nomes, pelo nome cru) o tratam como vazio, sem repetir a consulta nem o
 * aviso.
 */
function skipFailedDays(loadMatches: LoadFlashscoreMatches): LoadFlashscoreMatches {
  const failed = new Set<string>();
  return async (sportId, day) => {
    const key = `${sportId}:${day}`;
    if (failed.has(key)) return null;
    try {
      return await loadMatches(sportId, day);
    } catch (error) {
      failed.add(key);
      throw error;
    }
  };
}

type AdjacentDaysSearch = {
  matches: FlashscoreMatch[];
  home: string;
  away: string;
  kickoffUtc: Date;
  kickoffInferido?: boolean;
  minScore: number;
  expectedTeamIds: { home: string | null; away: string | null };
  /** Competição da aposta: a categoria que ela declara vale para os dois times. */
  competition?: string | null;
  /** Outros nomes de cada lado para a parcial (`scoreFlashscoreCandidates`). */
  alternatives?: { home: readonly string[]; away: readonly string[] };
  sportId: number;
  day: string;
  loadMatches: LoadFlashscoreMatches;
};

/**
 * O confronto no catálogo do dia e nos vizinhos. A primeira passada é pelos
 * ids que as fichas conhecem, em todos os dias. Com um id só, ele é dica: quando
 * não decide a partida, os nomes decidem, como sem ficha. Com os dois, o id
 * que aparece no catálogo sem o jogo certo segura a busca: o nome escolheria
 * um homônimo (Inter de Limeira × Grêmio Novorizontino no lugar do Gre-Nal), e
 * a aposta fica para o dono. Se nenhum dos dois aparece em partida nenhuma da
 * janela, a ficha pode estar errada e não veta: os nomes decidem, com o piso
 * do pareamento dos catálogos.
 */
export async function findFlashscoreCandidateWithAdjacentDays(
  params: AdjacentDaysSearch,
): Promise<FindFlashscoreMatchResult> {
  const search = { ...params, loadMatches: skipFailedDays(params.loadMatches) };
  const ids = [params.expectedTeamIds.home, params.expectedTeamIds.away].filter((id): id is string => Boolean(id));
  const withStore = await pickAcrossDays(search);
  if (withStore.ok || ids.length === 0) return withStore;
  if (ids.length === 1) return pickAcrossDays({ ...search, expectedTeamIds: { home: null, away: null } });
  if (withStore.reason !== "no_candidate") return withStore;
  const window = await matchesAcrossDays(search);
  if (flashscoreTeamIdsListed({ matches: window, teamIds: ids, kickoffUtc: params.kickoffUtc, kickoffInferido: params.kickoffInferido })) {
    return withStore;
  }
  return findFlashscoreMatchByStrictNames({ ...params, matches: window });
}

/** As partidas do dia e dos vizinhos que o catálogo deu. */
async function matchesAcrossDays(params: AdjacentDaysSearch): Promise<FlashscoreMatch[]> {
  const all = new Map(params.matches.map((match) => [match.match_id, match]));
  await searchAdjacentDays(params, (adjacent) => {
    for (const match of adjacent) all.set(match.match_id, match);
    return null;
  }, { message: "falha ao consultar dia adjacente; busca pelos nomes segue sem ele" });
  return [...all.values()];
}

async function pickAcrossDays(params: AdjacentDaysSearch): Promise<FindFlashscoreMatchResult> {
  const found = findFlashscoreMatch(params);
  // Com os dois ids esperados, a parcial do dia não encerra a busca: a partida
  // com os dois ids no dia vizinho vem antes dela.
  const bothIds = Boolean(params.expectedTeamIds.home && params.expectedTeamIds.away);
  const partialOnly = found.ok && bothIds && found.best.strategy === "provider_id_partial";
  if (found.ok && !partialOnly && !params.kickoffInferido) return found;
  // Sem horário no post, o dia é apenas uma âncora: compara os dias juntos
  // para não escolher o primeiro de dois confrontos possíveis.
  const candidates = new Map(params.matches.map((match) => [match.match_id, match]));
  const adjacentFound = await searchAdjacentDays(params, (adjacent) => {
    if (params.kickoffInferido) {
      for (const match of adjacent) candidates.set(match.match_id, match);
      return null;
    }
    const result = findFlashscoreMatch({
      matches: adjacent,
      home: params.home,
      away: params.away,
      kickoffUtc: params.kickoffUtc,
      minScore: params.minScore,
      expectedTeamIds: params.expectedTeamIds,
      competition: params.competition,
      alternatives: params.alternatives,
    });
    if (!result.ok) return null;
    return partialOnly && result.best.strategy !== "provider_id" ? null : result;
  }, { message: "falha ao consultar dia adjacente; busca principal preservada" });
  if (adjacentFound) return adjacentFound;
  return params.kickoffInferido
    ? findFlashscoreMatch({ ...params, matches: [...candidates.values()] })
    : found;
}

function findMatchById(
  matches: readonly FlashscoreMatch[],
  matchId: string,
): FlashscoreMatch | null {
  return (
    matches.find((m) => m.match_id === matchId || (m as { id?: string }).id === matchId) ?? null
  );
}

export async function findFlashscoreMatchByIdWithAdjacentDays(params: {
  matches: FlashscoreMatch[];
  matchId: string;
  sportId: number;
  day: string;
  loadMatches: LoadFlashscoreMatches;
}): Promise<FlashscoreMatch | null> {
  return findMatchById(params.matches, params.matchId)
    ?? searchAdjacentDays(params, (adjacent) => findMatchById(adjacent, params.matchId), {
      message: "falha ao consultar dia adjacente por ID; busca principal preservada",
      fields: { matchId: params.matchId },
    });
}

/**
 * A partida da aposta começa a no máximo 3 h do horário real dela. É trava da
 * PARTIDA, não da ficha: a busca por nome aceita jogo até 18 h do kickoff, e
 * sem ela o jogo do principal horas depois do da reserva, ou o do mesmo par no
 * dia seguinte, liquidaria a aposta. As 3 h cobrem o jogo remarcado depois do
 * casamento, que a aposta ainda guarda no horário velho. Vale para quem decide
 * a partida: a liquidação, a prop de jogador e o vínculo antecipado do enrich.
 */
const FIXTURE_KICKOFF_TOLERANCE_MS = 3 * 60 * 60_000;

export function flashscoreKickoffFitsBet(match: { timestamp: number }, betKickoff: Date): boolean {
  return Math.abs(match.timestamp * 1_000 - betKickoff.getTime()) <= FIXTURE_KICKOFF_TOLERANCE_MS;
}

/**
 * Folga mínima entre as duas orientações (soma dos dois lados, de 0 a 2) para
 * o mando valer pelos nomes. Depois da identidade, a aposta tem os nomes da
 * Pinnacle e a folga é perto de 2.
 */
const ORIENTATION_MARGIN = 0.5;

/**
 * O confronto está na orientação do outro par (`false`), invertido (`true`),
 * ou não dá para dizer (`null`), pelos dois lados. Cada lado vale pelo mais
 * parecido dos nomes que tem (o da aposta, a tradução da ficha, as outras
 * grafias): um lado só não decide, porque o nome do tipster pode não parecer
 * com nenhum dos dois times.
 */
function pairSwapped(
  names: { home: readonly string[]; away: readonly string[] },
  other: { home: string; away: string },
): boolean | null {
  const [otherHome, otherAway] = [other.home, other.away].map(canonicalizeTeamName);
  const similarity = (side: readonly string[], target: string) =>
    Math.max(0, ...side.map((name) => teamSimilarityCanon(canonicalizeTeamName(name), target)));
  const direct = similarity(names.home, otherHome!) + similarity(names.away, otherAway!);
  const inverted = similarity(names.home, otherAway!) + similarity(names.away, otherHome!);
  if (Math.abs(direct - inverted) < ORIENTATION_MARGIN) return null;
  return inverted > direct;
}

/**
 * O mando da aposta no jogo já vinculado, sem ligação dos catálogos: pelos ids
 * dos times que as fichas dão e, sem eles, pelos nomes dos dois lados. Ids que
 * se contradizem e nomes sem folga não decidem.
 */
function orientationOfLinkedMatch(
  match: FlashscoreMatch,
  search: Pick<FlashscoreIdentitySearch, "searchTeams" | "expectedTeamIds" | "alternatives">,
): boolean | null {
  const { home, away } = search.expectedTeamIds;
  const fixture = { home: match.home_team?.team_id, away: match.away_team?.team_id };
  const direct = (home !== null && home === fixture.home) || (away !== null && away === fixture.away);
  const inverted = (home !== null && home === fixture.away) || (away !== null && away === fixture.home);
  if (direct !== inverted) return inverted;
  if (direct) return null;
  return pairSwapped(
    {
      home: [search.searchTeams.home, ...search.alternatives.home],
      away: [search.searchTeams.away, ...search.alternatives.away],
    },
    { home: match.home_team.name, away: match.away_team.name },
  );
}

/** O que a ligação sabe do jogo: os ids dos times no FlashScore e a orientação da aposta contra eles. */
type LinkedFixture = {
  flashscoreMatchId: string;
  homeTeamId: string;
  awayTeamId: string;
  /** O mandante da aposta é o visitante do FlashScore, como a ligação gravou os ids. */
  swapped: boolean;
};

/**
 * A orientação da partida que o FlashScore devolve agora, pelos ids dos
 * times: os mesmos da ligação mantêm a orientação, invertidos a invertem, e
 * outros ids recusam (o jogo não é mais o que o pareamento viu).
 */
function orientationByTeamIds(match: FlashscoreMatch, link: LinkedFixture): boolean | null {
  const home = match.home_team?.team_id;
  const away = match.away_team?.team_id;
  if (home === link.homeTeamId && away === link.awayTeamId) return link.swapped;
  if (home === link.awayTeamId && away === link.homeTeamId) return !link.swapped;
  return null;
}

/**
 * Candidato por um id de jogo já conhecido (o `resultMatchId` vinculado ou o
 * jogo da ligação dos catálogos). A orientação mandante/visitante vem dos ids
 * dos times da ligação, quando ela é deste jogo, ou dos ids das fichas e dos
 * nomes dos dois lados. Jogo fora do horário da aposta, sem mando claro, que
 * atravessa a categoria dela (o jogo feminino numa aposta do masculino) ou
 * com outros times que os da ligação não vale: a busca decide de novo.
 *
 * O jogo já vinculado que o FlashScore marca como adiado ou cancelado fica
 * mesmo fora do horário (`linked`): o vínculo nasceu dentro das 3 h, e o
 * horário novo é o da remarcação. Solto, ele nunca chegaria ao reembolso.
 */
async function buildFlashscoreProviderIdCandidate(params: {
  matches: FlashscoreMatch[];
  matchId: string;
  teams: { home: string; away: string };
  link?: LinkedFixture;
  search: FlashscoreIdentitySearch;
  /** O id é o `resultMatchId` de uma observação anterior, não o da ligação. */
  linked: boolean;
  competition: string;
  kickoffUtc: Date;
  sportId: number;
  day: string;
  loadMatches: LoadFlashscoreMatches;
}): Promise<FlashscoreMatchCandidate | null> {
  const directMatch = await findFlashscoreMatchByIdWithAdjacentDays(params);
  if (!directMatch) return null;
  const notPlayed = directMatch.match_status.is_postponed || directMatch.match_status.is_cancelled;
  if (!flashscoreKickoffFitsBet(directMatch, params.kickoffUtc) && !(params.linked && notPlayed)) return null;
  const swapped = params.link
    ? orientationByTeamIds(directMatch, params.link)
    : orientationOfLinkedMatch(directMatch, params.search);
  if (swapped === null) return null;
  if (flashscoreMatchCrossesCategory({
    match: directMatch,
    ...params.teams,
    swapped,
    competition: params.competition,
  })) return null;
  return { match: directMatch, score: 2, swapped, strategy: "provider_id" };
}

async function recordFlashscoreIdentityResolution(
  search: FlashscoreIdentitySearch,
): Promise<void> {
  const sides = [search.resolved.homeResolution, search.resolved.awayResolution];
  const result = sides.some((side) => side.strategy === "ambiguous")
    ? "ambiguous"
    : sides.every(manteveNomeDeEntrada)
      ? "absence"
      : "card";
  await recordOperationalMetric({
    kind: "action",
    name: "team_identity.resolve",
    outcome: "success",
    labels: {
      provider: "flashscore",
      result,
      home: search.resolved.homeResolution.strategy,
      away: search.resolved.awayResolution.strategy,
      providerIds:
        Number(Boolean(search.expectedTeamIds.home)) +
        Number(Boolean(search.expectedTeamIds.away)),
    },
  });
}

/**
 * Os ids FlashScore que as fichas dão para os times da aposta, só quando o
 * time do id é da categoria da aposta. A ficha do "Chelsea" guarda o id do
 * masculino, que não acha o jogo da "Champions League Women"; sem o id, a
 * busca por nome acha. A categoria da aposta é a do nome do time ou, se ele não
 * declara nenhuma, a da competição; a do id é a do nome do FlashScore da ficha.
 */
export function expectedFlashscoreTeamIds(params: {
  teams: { home: string; away: string };
  resolved: ResolvedTeamsForProvider;
  competicao: string;
}): { home: string | null; away: string | null } {
  const idFor = (name: string, resolution: ResolvedProviderTeam) =>
    resolution.providerTeamId && sameTeamCategory(
      teamCategoryInContext(name, params.competicao),
      teamCategoryInContext(resolution.resolvedName),
    )
      ? resolution.providerTeamId
      : null;
  return {
    home: idFor(params.teams.home, params.resolved.homeResolution),
    away: idFor(params.teams.away, params.resolved.awayResolution),
  };
}

export async function prepareFlashscoreIdentitySearch(params: {
  teams: { home: string; away: string };
  bet: IdentityBet;
  /** Competição cuja categoria vale para os times; por padrão, a da aposta. */
  competition?: string;
}): Promise<FlashscoreIdentitySearch> {
  const [canonical, pinnacleResolved] = await resolveTeamsForProviders(
    params.teams,
    [TEAM_PROVIDERS.FLASHSCORE, TEAM_PROVIDERS.PINNACLE],
    { sport: params.bet.esporte, pais: params.bet.pais, competicao: params.bet.competicao },
  );
  // Sem ficha que dê o nome do FlashScore, busca pela tradução Pinnacle (que
  // inclui o mapa estático de seleções): é a grafia mais próxima que o feed
  // costuma usar.
  const pinnacle = await pinnacleTeamsFrom(params.teams, pinnacleResolved, params.bet.esporte);
  const withPinnacleName = (resolution: ResolvedProviderTeam, pinnacleName: string): ResolvedProviderTeam =>
    manteveNomeDeEntrada(resolution) && pinnacleName !== resolution.inputName
      ? { ...resolution, resolvedName: pinnacleName, strategy: "pinnacle_translation" }
      : resolution;
  const homeResolution = withPinnacleName(canonical.homeResolution, pinnacle.home);
  const awayResolution = withPinnacleName(canonical.awayResolution, pinnacle.away);
  const searchTeams = { home: homeResolution.resolvedName, away: awayResolution.resolvedName };
  return {
    resolved: { ...canonical, ...searchTeams, homeResolution, awayResolution },
    searchTeams,
    expectedTeamIds: expectedFlashscoreTeamIds({
      teams: params.teams,
      resolved: canonical,
      competicao: params.competition ?? params.bet.competicao,
    }),
    alternatives: flashscoreSearchAlternatives(params.teams, canonical),
  };
}

/** Os outros nomes de cada lado para a busca: o nome cru da aposta e as outras grafias da ficha. */
export function flashscoreSearchAlternatives(
  teams: { home: string; away: string },
  resolved: ResolvedTeamsForProvider,
): { home: string[]; away: string[] } {
  return {
    home: [teams.home, ...resolved.homeResolution.alternativeNames],
    away: [teams.away, ...resolved.awayResolution.alternativeNames],
  };
}

export type FlashscoreFixtureMatch =
  | { kind: "not_found"; reason: string; search: FlashscoreIdentitySearch }
  | {
      kind: "matched";
      search: FlashscoreIdentitySearch;
      candidate: FlashscoreMatchCandidate;
      source: FlashscoreMatchSource;
    };

/**
 * O jogo do FlashScore que o pareamento dos catálogos ligou ao evento da
 * identidade, com os ids dos times e a orientação da aposta contra eles. Só a
 * ligação `ok` e 1:1, no esporte da aposta, e com a aposta claramente numa
 * das orientações dos nomes da Pinnacle17 da ligação.
 */
async function catalogLinkOf(
  pinnacleEventId: string,
  bet: IdentityBet,
  teams: { home: string; away: string },
): Promise<LinkedFixture | "no_link" | "orientation"> {
  const link = await findUsableCatalogLink(pinnacleEventId);
  if (!link || link.sport !== bet.esporte) return "no_link";
  const betSwapped = pairSwapped(
    { home: [teams.home], away: [teams.away] },
    { home: link.pinnacleHome, away: link.pinnacleAway },
  );
  if (betSwapped === null) return "orientation";
  return {
    flashscoreMatchId: link.flashscoreMatchId,
    homeTeamId: link.flashscoreHomeTeamId,
    awayTeamId: link.flashscoreAwayTeamId,
    swapped: betSwapped !== link.swapped,
  };
}

/**
 * Casa um confronto ("A vs B") numa partida do catálogo. `knownMatchId` é o
 * `resultMatchId` de uma observação anterior: quando ainda está no catálogo, no
 * horário e na categoria da aposta, dispensa a busca por nome. Sem ele,
 * `catalogLinkEventId` (o id do evento da identidade na Pinnacle17 ou na
 * BridgeOdds) aponta o jogo ligado pelo pareamento, com as mesmas travas.
 * `competition` é a competição cuja categoria vale para os dois times: a da
 * aposta simples; o bilhete passa vazio, porque a competição dele não é a de
 * cada perna, e marca `ticketLeg`, porque o horário dele também não é.
 */
export async function matchFlashscoreFixture(params: {
  teams: { home: string; away: string };
  bet: IdentityBet;
  matches: FlashscoreMatch[];
  sportId: number;
  day: string;
  loadMatches: LoadFlashscoreMatches;
  knownMatchId?: string | null;
  catalogLinkEventId?: string | null;
  competition?: string;
  /**
   * O horário da aposta é o do bilhete, não o deste confronto: a perna vale na
   * janela da busca, sem a trava de 3 h, que soltaria o segundo jogo da noite.
   */
  ticketLeg?: boolean;
}): Promise<FlashscoreFixtureMatch> {
  const competition = params.competition ?? params.bet.competicao;
  const loadMatches = skipFailedDays(params.loadMatches);
  const search = await prepareFlashscoreIdentitySearch({ teams: params.teams, bet: params.bet, competition });
  await recordFlashscoreIdentityResolution(search);

  const linkLookup = params.catalogLinkEventId
    ? await catalogLinkOf(params.catalogLinkEventId, params.bet, params.teams)
    : null;
  const link = typeof linkLookup === "object" ? linkLookup : null;
  // O jogo ligado passa pelas mesmas travas do vínculo por id (3 h do horário
  // da aposta, categoria), e o mando vem dos ids dos times que o FlashScore
  // devolve agora: a semelhança dos nomes falha justamente quando eles pouco
  // se parecem, e o FlashScore pode ter invertido o mando depois da ligação.
  const byId = {
    matches: params.matches, teams: params.teams, search, competition, kickoffUtc: params.bet.data,
    sportId: params.sportId, day: params.day, loadMatches,
  };
  let source: FlashscoreMatchSource = "result_match";
  let candidate = params.knownMatchId
    ? await buildFlashscoreProviderIdCandidate({
        ...byId,
        matchId: params.knownMatchId,
        linked: true,
        ...(link?.flashscoreMatchId === params.knownMatchId ? { link } : {}),
      })
    : null;
  if (!candidate && !params.knownMatchId && params.catalogLinkEventId) {
    source = "catalog_link";
    candidate = link
      ? await buildFlashscoreProviderIdCandidate({ ...byId, matchId: link.flashscoreMatchId, link, linked: false })
      : null;
    await recordOperationalMetric({
      kind: "action",
      name: "flashscore.catalog_link",
      outcome: "success",
      labels: { result: link ? (candidate ? "used" : "refused") : (typeof linkLookup === "string" ? linkLookup : "no_link") },
    });
  }
  if (!candidate) {
    source = "search";
    const find = (teams: { home: string; away: string }, expectedTeamIds: FlashscoreIdentitySearch["expectedTeamIds"]) =>
      findFlashscoreCandidateWithAdjacentDays({
        matches: params.matches,
        home: teams.home,
        away: teams.away,
        kickoffUtc: params.bet.data,
        minScore: getEnv().SHARP_AUTO_MATCH_MIN_SCORE,
        expectedTeamIds,
        competition,
        alternatives: search.alternatives,
        sportId: params.sportId,
        day: params.day,
        loadMatches,
      });
    let found = await find(search.searchTeams, search.expectedTeamIds);
    // A categoria vale pelo nome da aposta, não pela tradução da ficha: se a
    // tradução levou o time feminino ao masculino, a busca refaz pelo nome cru.
    // Os ids ficam: já são da categoria da aposta.
    if (found.ok && flashscoreMatchCrossesCategory({
      match: found.best.match,
      ...params.teams,
      swapped: found.best.swapped,
      competition,
    })) {
      found = await find(params.teams, search.expectedTeamIds);
    }
    if (!found.ok) return { kind: "not_found", reason: found.reason, search };
    if (!params.ticketLeg && !flashscoreKickoffFitsBet(found.best.match, params.bet.data)) {
      return { kind: "not_found", reason: "kickoff_mismatch", search };
    }
    candidate = found.best;
  }
  return { kind: "matched", search, candidate, source };
}
