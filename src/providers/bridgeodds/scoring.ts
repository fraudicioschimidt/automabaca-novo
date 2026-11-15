import {
  betDeclaresCategoryFixtureLacks,
  canonicalizeTeamName,
  categoryTokensFromLeague,
  fixtureHasAnchorSide,
  leagueCoversBetCategory,
  refineCategoryCandidates,
  reserveSuffixMismatch,
  teamCategoryTokens,
  teamSideSimilarityCanon,
} from "@/src/domain/text";
import { areCategoriesCompatible, stripCategoryTokens } from "@/src/domain/team-category";
import type { QueryOpeningClosingResult } from "./client";
import type { BridgeMatch } from "./types";

/**
 * Pontuação de fixtures da BridgeOdds contra o evento local.
 *
 * Pisos de similaridade: cada lado ≥ 0.3 e soma ≥ 0.7. Só filtram CANDIDATOS
 * para a zona cinzenta.
 * NÃO gravam identidade sozinhos. Quem aplica é o enrich:
 *   score ≥ SHARP_AUTO_MATCH_MIN_SCORE (default 1.5) → AUTO
 *   entre SUM_FLOOR e AUTO → LLM-judge (confidence ≥ SHARP_JUDGE_MIN_CONFIDENCE)
 *   abaixo / juiz recusa → TrainingCase OPEN (fila humana)
 *
 * Vive separado de `match.ts` porque o catálogo do dia (`catalog.ts`) também
 * precisa preparar fixtures; importar do módulo de busca criaria ciclo.
 */

export const SIDE_FLOOR = 0.3;
const SUM_FLOOR = 0.7;

/**
 * Time de CATEGORIA diferente não é candidato, não importa o score.
 *
 * A similaridade de categorias protegidas diferentes é cravada em 0,35, que
 * passa pelo `SIDE_FLOOR` (0,3) e, nos dois lados, soma exatamente o
 * `SUM_FLOOR` (0,70): sem esta recusa explícita, `Botafogo (F) vs São Paulo
 * (F)` virava candidato do jogo masculino.
 *
 * O sufixo numérico entra pelo mesmo motivo: "River Plate 2" não disputa a
 * fixture do "River Plate", e o dígito não tem o teto 0,35, então a
 * similaridade sozinha faria AUTO. `Celta Fortuna` ↔ `Celta Vigo II`
 * continua: não há dígito, e a assimetria de `betDeclaresCategoryFixtureLacks`
 * preserva a variação de nome.
 */
function categoriaIncompativel(canonAposta: string, canonFixture: string, league?: string): boolean {
  const declarada = betDeclaresCategoryFixtureLacks(canonAposta, canonFixture)
    || reserveSuffixMismatch(canonAposta, canonFixture);
  if (!declarada) {
    const ligaTokens = categoryTokensFromLeague(league ?? "");
    if (ligaTokens.has("women") && !teamCategoryTokens(canonAposta).has("women")) {
      return true;
    }
    return false;
  }
  // A categoria pode estar na COMPETIÇÃO em vez do nome: a Pinnacle chama o
  // reserva de "Gimnasia La Plata" dentro de "Argentina - Liga Pro Reserves".
  return !leagueCoversBetCategory(canonAposta, canonFixture, league);
}
/** Fixtures fora de ±2d do kickoff âncora são ignoradas no matching normal. */
export const KICKOFF_WINDOW_MS = 2 * 86_400_000;

export type BridgeMatchCandidate = {
  match: BridgeMatch;
  score: number;
  swapped: boolean;
};

/** Query injetável: array (testes) ou resultado tipado (client real). */
export type BridgeQueryFn = (params: {
  date: string;
  sport: string;
  filters?: { home?: string; away?: string; league?: string };
  stopWhen?: (all: BridgeMatch[]) => boolean;
  maxPages?: number;
  deadlineMs?: number;
}) => Promise<BridgeMatch[] | QueryOpeningClosingResult>;

/**
 * Fixture com os nomes já canonicalizados. O catálogo do dia é lido uma vez e
 * comparado contra MUITAS apostas; canonicalizar por aposta desperdiçaria CPU
 * (374 jogos × N apostas × 2 nomes). Preparar no catálogo paga esse custo 1×.
 */
export type PreparedBridgeMatch = {
  match: BridgeMatch;
  homeCanon: string;
  awayCanon: string;
};

export function prepareBridgeMatches(results: BridgeMatch[]): PreparedBridgeMatch[] {
  return results.map((match) => ({
    match,
    homeCanon: canonicalizeTeamName(match.home),
    awayCanon: canonicalizeTeamName(match.away),
  }));
}

export function scorePreparedCandidates(
  prepared: ReadonlyArray<PreparedBridgeMatch>,
  home: string,
  away: string,
  kickoffUtc?: Date,
  /** Campeonato da aposta e se o horário dela é só o dia: a categoria decide o gêmeo. */
  context: { competition?: string | null; kickoffInferido?: boolean } = {},
): BridgeMatchCandidate[] {
  const out: BridgeMatchCandidate[] = [];
  // Lado da aposta é fixo no laço — canonicaliza 1× (em vez de por candidato).
  const cHome = canonicalizeTeamName(home);
  const cAway = canonicalizeTeamName(away);
  for (const { match, homeCanon: cmHome, awayCanon: cmAway } of prepared) {
    if (kickoffUtc) {
      // Fixture que não dá para datar não compete por semelhança de nome:
      // homônimo em outra data ("Nacional", "Barcelona") venceria o candidato
      // certo. `match_date` é obrigatório no contrato; isto é só guarda.
      const kickMs = match.match_date ? new Date(match.match_date).getTime() : Number.NaN;
      if (!Number.isFinite(kickMs)) continue;
      if (Math.abs(kickMs - kickoffUtc.getTime()) > KICKOFF_WINDOW_MS) continue;
    }
    const coveredHome = areCategoriesCompatible({
      betCanon: cHome,
      fixtureCanon: cmHome,
      fixtureLeague: match.league,
    }).coveredTokens;
    const coveredAway = areCategoriesCompatible({
      betCanon: cAway,
      fixtureCanon: cmAway,
      fixtureLeague: match.league,
    }).coveredTokens;

    const sHome = stripCategoryTokens(cHome, coveredHome);
    const smHome = stripCategoryTokens(cmHome, coveredHome);
    const sAway = stripCategoryTokens(cAway, coveredAway);
    const smAway = stripCategoryTokens(cmAway, coveredAway);

    const directHome = teamSideSimilarityCanon(smHome, sHome);
    const directAway = teamSideSimilarityCanon(smAway, sAway);
    const invertedHome = teamSideSimilarityCanon(smHome, sAway);
    const invertedAway = teamSideSimilarityCanon(smAway, sHome);
    const direct = directHome.score + directAway.score;
    const inverted = invertedHome.score + invertedAway.score;
    const swapped = inverted > direct;
    const home = swapped ? invertedHome : directHome;
    const away = swapped ? invertedAway : directAway;
    const hs = home.score;
    const as = away.score;
    const ladoCasa = swapped ? cAway : cHome;
    const ladoFora = swapped ? cHome : cAway;
    if (categoriaIncompativel(ladoCasa, cmHome, match.league) || categoriaIncompativel(ladoFora, cmAway, match.league)) {
      continue;
    }
    if (hs < SIDE_FLOOR || as < SIDE_FLOOR) continue;
    // Nenhum lado casou por evidência: os dois vieram da mistura fuzzy ou do
    // resgate de digitação, e a soma não afirma identidade. Ver
    // `ANCHOR_SIDE_FLOOR` — é a única guarda que separa "um lado é apelido do
    // outro" de "as duas linhas se parecem".
    if (!fixtureHasAnchorSide(home.evidence, away.evidence)) continue;
    const score = hs + as;
    if (score < SUM_FLOOR) continue;
    out.push({ match, score, swapped });
  }
  return refineCategoryCandidates({
    betHome: home,
    betAway: away,
    betLeague: context.competition,
    betKickoffMs: kickoffUtc && !context.kickoffInferido ? kickoffUtc.getTime() : null,
    candidates: out.sort((a, b) => b.score - a.score),
    fixture: ({ match, swapped }) => ({
      home: match.home, away: match.away, league: match.league, country: match.league.split(" - ")[0] ?? null,
      kickoffMs: new Date(match.match_date).getTime(), swapped,
    }),
    collapseDuplicateListings: true,
  });
}

