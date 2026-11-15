import {
  canonicalizeTeamName,
  matchCanonTeamsWithCategoryContext,
  refineCategoryCandidates,
  teamCategoryConflictInContext,
} from "@/src/domain/text";
import type { FlashscoreCatalogMatch, FlashscoreMatch } from "./types";

const SIDE_FLOOR = 0.3;
const SUM_FLOOR = 0.7;
/**
 * Janela da BUSCA com horário real: o candidato mais distante ainda conta para
 * a ambiguidade. Não é a trava da partida; quem decide o jogo da aposta só o
 * aceita a até 3 h do horário dela (`flashscoreKickoffFitsBet`).
 */
const KICKOFF_WINDOW_MS = 18 * 60 * 60_000;
/** Post sem hora: o dia é só âncora. */
const INFERRED_KICKOFF_WINDOW_MS = 36 * 60 * 60_000;
const AMBIGUITY_MARGIN = 0.12;
/**
 * A passada pelos nomes quando os dois ids que as fichas davam não aparecem no
 * catálogo: cada lado com evidência própria ≥ 0,85 e 0,3 de folga sobre
 * qualquer outro jogo compatível, como no pareamento dos catálogos.
 */
const STRICT_SIDE_EVIDENCE = 0.85;
/**
 * E um lado quase idêntico: nome contido no outro vale 0,90 dos dois lados, e
 * "Inter" × "Grêmio" acharia "Inter de Limeira" × "Grêmio Novorizontino".
 */
const STRICT_ANCHOR_EVIDENCE = 0.95;
const STRICT_MARGIN = 0.3;
/**
 * Doubleheader (MLB/CS2 Bo3): dois jogos do MESMO par de times no mesmo dia
 * casam ambos por provider_id com score idêntico (2). Desempata pelo kickoff
 * mais próximo; se o segundo candidato estiver a menos desta margem de
 * distância do primeiro, recusa como ambíguo — liquidar o jogo 2 com o placar
 * do jogo 1 é dinheiro invertido.
 */
const PROVIDER_ID_TIEBREAK_MARGIN_MS = 60 * 60_000;

const FLASHSCORE_TEAM_TOKEN_ALIASES: Readonly<Record<string, string>> = {
  ind: "independiente",
  indepediente: "independiente",
  medelin: "medellin",
};

/** Nome do FlashScore na forma canônica, sem o país/estado que ele acrescenta. */
export function canonicalizeFlashscoreTeamName(name: string | null | undefined): string {
  if (!name) return "";
  // FlashScore acrescenta país/estado ao nome de exibição. Esses sufixos não
  // identificam outro time e derrubariam matches corretos abaixo do limiar.
  // "(Am)" fica: é o time amador, não um país.
  const withoutProviderSuffix = name
    .replace(/\s+\((?!Am\))[A-Za-z]{2,3}\)\s*$/, "")
    .replace(/-[a-z]{2}\s*$/i, "");
  return canonicalizeTeamName(withoutProviderSuffix)
    .split(" ")
    .map((token) => FLASHSCORE_TEAM_TOKEN_ALIASES[token] ?? token)
    .join(" ");
}

export type FlashscoreMatchCandidate = {
  match: FlashscoreMatch | FlashscoreCatalogMatch;
  score: number;
  swapped: boolean;
  strategy: "provider_id" | "provider_id_partial" | "fuzzy";
};

export type FindFlashscoreMatchResult =
  | { ok: true; best: FlashscoreMatchCandidate; candidates: FlashscoreMatchCandidate[] }
  | { ok: false; reason: "no_candidate" | "below_threshold" | "ambiguous" };

function tournamentName(match: FlashscoreMatch | FlashscoreCatalogMatch): string | null {
  return "tournament" in match ? match.tournament.name : null;
}

type CategoryLeagues = { betLeague?: string | null; fixtureLeague: string | null };

/**
 * Feminino, base ou dígito de reserva nos dois lados já orientados, lendo a
 * competição da aposta e a da partida. Recebe os nomes na forma canônica do
 * FlashScore (sem o sufixo de país).
 */
function pairCrossesCategory(
  local: { home: string; away: string },
  provider: { home: string; away: string },
  swapped: boolean,
  leagues: CategoryLeagues,
): boolean {
  return teamCategoryConflictInContext({ betName: swapped ? local.away : local.home, fixtureName: provider.home, ...leagues })
    || teamCategoryConflictInContext({ betName: swapped ? local.home : local.away, fixtureName: provider.away, ...leagues });
}

/** A partida, na orientação dada, é de outra categoria que a do confronto da aposta? */
export function flashscoreMatchCrossesCategory(params: {
  match: FlashscoreMatch | FlashscoreCatalogMatch;
  home: string;
  away: string;
  swapped: boolean;
  competition?: string | null;
}): boolean {
  return pairCrossesCategory(
    { home: canonicalizeFlashscoreTeamName(params.home), away: canonicalizeFlashscoreTeamName(params.away) },
    {
      home: canonicalizeFlashscoreTeamName(params.match.home_team.name),
      away: canonicalizeFlashscoreTeamName(params.match.away_team.name),
    },
    params.swapped,
    { betLeague: params.competition, fixtureLeague: tournamentName(params.match) },
  );
}

/**
 * Candidatos do catálogo para o confronto da aposta. Com os ids que as fichas
 * dão, só as partidas que têm algum deles; sem ids, os nomes (a linha de
 * base). A categoria (feminino, reserva, base) é lida nos nomes e nas
 * competições dos dois lados: nenhum candidato atravessa categoria, nem pelo id
 * conhecido, e a categoria que as ligas explicam sai da comparação de nomes.
 */
export function scoreFlashscoreCandidates(params: {
  matches: readonly FlashscoreMatch[];
  home: string;
  away: string;
  kickoffUtc: Date;
  kickoffInferido?: boolean;
  expectedTeamIds?: { home: string | null; away: string | null };
  /**
   * Competição da aposta. A Pinnacle chama de "Chelsea" o time da "Champions
   * League Women"; o FlashScore, de "Chelsea W".
   */
  competition?: string | null;
  /**
   * Outros nomes de cada lado (o nome cru da aposta, as outras grafias da
   * ficha): o lado sem âncora da parcial vale pelo mais parecido deles.
   */
  alternatives?: { home: readonly string[]; away: readonly string[] };
}): FlashscoreMatchCandidate[] {
  const localHome = canonicalizeFlashscoreTeamName(params.home);
  const localAway = canonicalizeFlashscoreTeamName(params.away);
  const candidates: FlashscoreMatchCandidate[] = [];

  for (const match of params.matches) {
    if (!match?.home_team?.name || !match?.away_team?.name) continue;
    if (!inSearchWindow(match, params)) continue;

    const expectedHomeId = params.expectedTeamIds?.home;
    const expectedAwayId = params.expectedTeamIds?.away;
    const directIdMatches =
      Number(Boolean(expectedHomeId && match.home_team.team_id === expectedHomeId)) +
      Number(Boolean(expectedAwayId && match.away_team.team_id === expectedAwayId));
    const invertedIdMatches =
      Number(Boolean(expectedHomeId && match.away_team.team_id === expectedHomeId)) +
      Number(Boolean(expectedAwayId && match.home_team.team_id === expectedAwayId));
    const expectedIdCount =
      Number(Boolean(expectedHomeId)) + Number(Boolean(expectedAwayId));
    const bestIdMatches = Math.max(directIdMatches, invertedIdMatches);
    if (expectedIdCount > 0 && (bestIdMatches === 0 || directIdMatches === invertedIdMatches)) continue;

    const providerHome = canonicalizeFlashscoreTeamName(match.home_team.name);
    const providerAway = canonicalizeFlashscoreTeamName(match.away_team.name);
    const leagues = { betLeague: params.competition, fixtureLeague: tournamentName(match) };
    // Vale também para o id conhecido: o do time masculino não liquida o jogo
    // feminino. Sem a guarda, Independiente funde Independiente 2 (~0,97).
    const categoryConflict = (swapped: boolean) => pairCrossesCategory(
      { home: localHome, away: localAway },
      { home: providerHome, away: providerAway },
      swapped,
      leagues,
    );
    if (bestIdMatches === 2) {
      const swapped = invertedIdMatches > directIdMatches;
      if (categoryConflict(swapped)) continue;
      candidates.push({ match, score: 2, swapped, strategy: "provider_id" });
      continue;
    }
    const names = matchCanonTeamsWithCategoryContext({
      betHome: localHome,
      betAway: localAway,
      fixtureHome: providerHome,
      fixtureAway: providerAway,
      ...leagues,
    });
    if (bestIdMatches === 1) {
      const swapped = invertedIdMatches > directIdMatches;
      // Um ID ancora um lado; o outro ainda é textual. Com os dois ids
      // esperados, o que não bateu não veta: o lado dele vale pelo nome.
      const homeAnchored = Boolean(expectedHomeId)
        && (swapped ? match.away_team.team_id : match.home_team.team_id) === expectedHomeId;
      const unknownSideScore = unanchoredSideScore({
        names, swapped, homeAnchored, localHome, localAway, providerHome, providerAway, leagues,
        alternatives: params.alternatives,
      });
      if (unknownSideScore < SIDE_FLOOR || categoryConflict(swapped)) continue;
      // Com os dois ids esperados, o lado sem âncora tem OUTRO id: por
      // definição é outro time, salvo nome quase idêntico (id do FlashScore
      // trocado). Sem isso, "Inter" de uma ficha errada levaria o Gre-Nal para
      // Inter de Limeira × Grêmio Novorizontino.
      if (expectedHomeId && expectedAwayId && unknownSideScore < STRICT_ANCHOR_EVIDENCE) continue;
      candidates.push({
        match,
        score: 1 + unknownSideScore,
        swapped,
        strategy: "provider_id_partial",
      });
      continue;
    }
    const swapped = names.swapped;
    const homeScore = swapped ? names.invertedHome : names.directHome;
    const awayScore = swapped ? names.invertedAway : names.directAway;
    const score = homeScore + awayScore;
    // Mesma guarda da BridgeOdds: o FlashScore é o liquidador primário de
    // RESULTADO. `provider_id` (dois IDs) já é âncora; fuzzy e parcial não.
    if (homeScore < SIDE_FLOOR || awayScore < SIDE_FLOOR || score < SUM_FLOOR) continue;
    if (!names.anchored) continue;
    if (categoryConflict(swapped)) continue;
    candidates.push({ match, score, swapped, strategy: "fuzzy" });
  }

  return refineCategoryCandidates({
    betHome: params.home,
    betAway: params.away,
    betLeague: params.competition,
    betKickoffMs: params.kickoffInferido ? null : params.kickoffUtc.getTime(),
    candidates: candidates.sort(
      (a, b) =>
        (b.strategy === "provider_id" ? 2 : b.strategy === "provider_id_partial" ? 1 : 0) -
          (a.strategy === "provider_id" ? 2 : a.strategy === "provider_id_partial" ? 1 : 0) ||
        b.score - a.score,
    ),
    fixture: ({ match, swapped }) => ({
      home: match.home_team.name, away: match.away_team.name, league: tournamentName(match), kickoffMs: match.timestamp * 1_000,
      swapped,
    }),
    collapseDuplicateListings: false,
  });
}

function inSearchWindow(match: { timestamp: number }, params: { kickoffUtc: Date; kickoffInferido?: boolean }): boolean {
  const windowMs = params.kickoffInferido ? INFERRED_KICKOFF_WINDOW_MS : KICKOFF_WINDOW_MS;
  return Math.abs(match.timestamp * 1_000 - params.kickoffUtc.getTime()) <= windowMs;
}

/**
 * O lado da parcial que o id não ancorou, pelo mais parecido entre o nome
 * traduzido e as alternativas: a tradução pode ter trocado o nome que o
 * FlashScore usa.
 */
function unanchoredSideScore(params: {
  names: ReturnType<typeof matchCanonTeamsWithCategoryContext>;
  swapped: boolean;
  homeAnchored: boolean;
  localHome: string;
  localAway: string;
  providerHome: string;
  providerAway: string;
  leagues: CategoryLeagues;
  alternatives?: { home: readonly string[]; away: readonly string[] };
}): number {
  const { names, swapped, homeAnchored } = params;
  const primary = homeAnchored
    ? (swapped ? names.invertedHome : names.directAway)
    : (swapped ? names.invertedAway : names.directHome);
  const alternatives = (homeAnchored ? params.alternatives?.away : params.alternatives?.home) ?? [];
  return alternatives.reduce((best, alternative) => {
    const alt = canonicalizeFlashscoreTeamName(alternative);
    if (!alt) return best;
    const altNames = matchCanonTeamsWithCategoryContext({
      betHome: homeAnchored ? params.localHome : alt,
      betAway: homeAnchored ? alt : params.localAway,
      fixtureHome: params.providerHome,
      fixtureAway: params.providerAway,
      ...params.leagues,
    });
    const score = homeAnchored
      ? (swapped ? altNames.invertedHome : altNames.directAway)
      : (swapped ? altNames.invertedAway : altNames.directHome);
    return Math.max(best, score);
  }, primary);
}

/**
 * A passada pelos nomes com o piso do pareamento dos catálogos, para quando os
 * dois ids que as fichas davam não aparecem em partida nenhuma da janela: a
 * ficha pode estar errada, e ela não veta a liquidação. Cada lado com evidência
 * própria ≥ 0,85, um deles ≥ 0,95, e 0,3 de folga sobre o segundo compatível;
 * a categoria vale como sempre.
 */
export function findFlashscoreMatchByStrictNames(params: {
  matches: readonly FlashscoreMatch[];
  home: string;
  away: string;
  kickoffUtc: Date;
  kickoffInferido?: boolean;
  competition?: string | null;
}): FindFlashscoreMatchResult {
  const localHome = canonicalizeFlashscoreTeamName(params.home);
  const localAway = canonicalizeFlashscoreTeamName(params.away);
  const compatible = params.matches.flatMap((match) => {
    if (!match?.home_team?.name || !match?.away_team?.name || !inSearchWindow(match, params)) return [];
    const providerHome = canonicalizeFlashscoreTeamName(match.home_team.name);
    const providerAway = canonicalizeFlashscoreTeamName(match.away_team.name);
    const leagues = { betLeague: params.competition, fixtureLeague: tournamentName(match) };
    const names = matchCanonTeamsWithCategoryContext({
      betHome: localHome, betAway: localAway, fixtureHome: providerHome, fixtureAway: providerAway, ...leagues,
    });
    if (!names.compatible) return [];
    if (pairCrossesCategory({ home: localHome, away: localAway }, { home: providerHome, away: providerAway }, names.swapped, leagues)) {
      return [];
    }
    return [{ match, names }];
  }).sort((a, b) => b.names.score - a.names.score);
  const [best, runnerUp] = compatible;
  if (!best) return { ok: false, reason: "no_candidate" };
  const sides = [best.names.evidenceHome, best.names.evidenceAway];
  if (Math.min(...sides) < STRICT_SIDE_EVIDENCE || Math.max(...sides) < STRICT_ANCHOR_EVIDENCE) {
    return { ok: false, reason: "below_threshold" };
  }
  if (runnerUp && best.names.score - runnerUp.names.score < STRICT_MARGIN) return { ok: false, reason: "ambiguous" };
  const candidate: FlashscoreMatchCandidate = {
    match: best.match, score: best.names.score, swapped: best.names.swapped, strategy: "fuzzy",
  };
  return { ok: true, best: candidate, candidates: [candidate] };
}

/** Algum dos ids está numa partida da janela da busca? */
export function flashscoreTeamIdsListed(params: {
  matches: readonly FlashscoreMatch[];
  teamIds: readonly string[];
  kickoffUtc: Date;
  kickoffInferido?: boolean;
}): boolean {
  const ids = new Set(params.teamIds);
  return params.matches.some((match) => inSearchWindow(match, params)
    && (ids.has(match.home_team?.team_id ?? "") || ids.has(match.away_team?.team_id ?? "")));
}

type FindFlashscoreMatchParams = {
  matches: readonly FlashscoreMatch[];
  home: string;
  away: string;
  kickoffUtc: Date;
  kickoffInferido?: boolean;
  minScore: number;
  expectedTeamIds?: { home: string | null; away: string | null };
  competition?: string | null;
  alternatives?: { home: readonly string[]; away: readonly string[] };
};

/**
 * Uma passada no catálogo: com ids das fichas, só as partidas que têm algum
 * deles; sem ids, os nomes. Quem combina as passadas (os ids como dica, os dias
 * vizinhos) é `findFlashscoreCandidateWithAdjacentDays`.
 */
export function findFlashscoreMatch(params: FindFlashscoreMatchParams): FindFlashscoreMatchResult {
  const candidates = scoreFlashscoreCandidates(params);
  const best = candidates[0];
  if (!best) return { ok: false, reason: "no_candidate" };
  if (best.score < params.minScore) return { ok: false, reason: "below_threshold" };
  if (best.strategy === "provider_id") {
    const idCandidates = candidates.filter((c) => c.strategy === "provider_id");
    if (idCandidates.length === 1) return { ok: true, best, candidates };
    if (params.kickoffInferido) return { ok: false, reason: "ambiguous" };
    // Doubleheader: ambos os jogos têm os MESMOS team_ids — o desempate é o
    // horário, nunca o primeiro da lista.
    const target = params.kickoffUtc.getTime();
    const byKickoff = [...idCandidates].sort(
      (a, b) =>
        Math.abs(a.match.timestamp * 1_000 - target) -
        Math.abs(b.match.timestamp * 1_000 - target),
    );
    const nearest = byKickoff[0];
    const runner = byKickoff[1];
    if (!nearest || !runner) return { ok: true, best, candidates };
    const nearestDist = Math.abs(nearest.match.timestamp * 1_000 - target);
    const runnerDist = Math.abs(runner.match.timestamp * 1_000 - target);
    if (runnerDist - nearestDist < PROVIDER_ID_TIEBREAK_MARGIN_MS) {
      return { ok: false, reason: "ambiguous" };
    }
    return { ok: true, best: nearest, candidates };
  }
  const runnerUp = candidates[1];
  if (runnerUp && best.score - runnerUp.score < AMBIGUITY_MARGIN) {
    return { ok: false, reason: "ambiguous" };
  }
  return { ok: true, best, candidates };
}
