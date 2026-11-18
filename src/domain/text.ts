import dominio from "@automabaca/dominio";

/**
 * Texto de aposta e de provider para matching: similaridade de nomes de time,
 * separação "A vs B" e slug. A normalização mora em `text-normalization.ts` e
 * as travas de categoria em `team-category.ts`; este módulo reexporta as duas
 * para que o resto do projeto importe tudo de um lugar. A regra mora em Rust
 * (`rust/crates/dominio/src/text.rs`).
 */
export * from "./text-normalization";
export {
  betDeclaresCategoryFixtureLacks,
  categoryTokensFromLeague,
  hasProtectedTeamCategoryConflict,
  leagueCoversBetCategory,
  orientedTeamPairHasReserveSuffixConflict,
  reserveSuffixMismatch,
  sameTeamCategory,
  teamCategoryConflictInContext,
  teamCategoryInContext,
  teamCategoryTokens,
  teamIdentityCategoryConflict,
} from "./team-category";

/**
 * Similaridade híbrida 0..1 entre nomes de time: containment + jaccard +
 * dice (bigramas), com boost para subconjunto pleno de tokens distintivos
 * ("Bayern" ⊂ "Bayern Munich" → ≥0.9) e substring canônica direta (≥0.85).
 * "Real Madrid" vs "Real Betis" fica baixo ("real" é stop-word).
 */
export function teamSimilarity(a: string, b: string): number {
  return dominio.teamSimilarity(a || "", b || "");
}

/**
 * Semelhança de um lado do confronto. `score` é o que soma no par; `evidence`
 * é a parte que pode ANCORAR o par (`ANCHOR_SIDE_FLOOR`): tudo menos o resgate
 * de digitação, que acha "Juventus" em "Juventud" (0,88) e por isso só
 * acompanha um lado que casou por outra razão.
 */
export type TeamSideSimilarity = { score: number; evidence: number };

/**
 * Núcleo de `teamSimilarity` para quem JÁ tem os nomes canonicalizados: laços
 * que comparam a aposta contra N candidatos canonicalizam o lado fixo uma vez.
 * String não canônica aqui dá resultado errado.
 */
export function teamSimilarityCanon(ca: string, cb: string): number {
  return dominio.teamSimilarityCanon(ca, cb);
}

/**
 * `teamSimilarityCanon` com a evidência de âncora. Vale o melhor entre os
 * nomes como vieram, as formas equivalentes do dicionário e a inicial
 * expandida ("A. Italiano" = "Audax Italiano").
 */
export function teamSideSimilarityCanon(ca: string, cb: string): TeamSideSimilarity {
  const [score, evidence] = dominio.teamSideSimilarityCanon(ca, cb);
  return { score, evidence };
}

/** A evidência de um par de nomes (sem o resgate de digitação), para a confiança de alias. */
export function teamNameEvidence(a: string, b: string): number {
  return dominio.teamNameEvidence(a || "", b || "");
}

const anchorSideFloor = dominio.anchorSideFloor();

/**
 * Piso do lado ÂNCORA de um confronto, sobre a `evidence` do lado. Um par pode
 * ter um lado fraco (apelido, patrocinador), mas não os dois.
 */
export const ANCHOR_SIDE_FLOOR = anchorSideFloor;

/**
 * O par tem um lado âncora? Chame ANTES de aceitar candidato por soma de lados,
 * com as EVIDÊNCIAS dos lados JÁ orientados (depois de decidir `swapped`).
 */
export function fixtureHasAnchorSide(homeEvidence: number, awayEvidence: number): boolean {
  return dominio.fixtureHasAnchorSide(homeEvidence, awayEvidence);
}

/** Melhor token para busca textual em provider (mais distintivo/longo). */
export function bestSearchWord(s: string): string {
  return dominio.bestSearchWord(s || "");
}

/**
 * Divide "Time A vs Time B" em casa/fora, tolerando os delimitadores comuns
 * (vs, v, versus, x, hífen, travessões). Null quando não é um confronto.
 */
export function splitEventoTeams(
  evento: string | null | undefined,
): { home: string; away: string } | null {
  const teams = dominio.splitEventoTeams(evento ?? "");
  return teams === null ? null : { home: teams[0], away: teams[1] };
}

/** Adversário inventado ou cortado, ou uma linha no lugar de um dos times:
 * “Blumenau -48.5 HA” não nomeia o adversário. */
export function fixtureHasPlaceholderTeam(evento: string): boolean {
  return dominio.fixtureHasPlaceholderTeam(evento || "");
}

/**
 * Os dois eventos descrevem o mesmo confronto? Compara mandante com mandante e
 * visitante com visitante; qualquer lado abaixo do limiar único de "mesmo
 * confronto com outro alias" (o da edição pelo painel e no canal) já reprova.
 */
export function sameFixtureTeams(
  eventoA: string | null | undefined,
  eventoB: string | null | undefined,
): boolean {
  return dominio.sameFixtureTeams(eventoA ?? "", eventoB ?? "");
}

/** "Tipster João" → "tipster-joao" (slug de URL). */
export function slugify(text: string): string {
  return dominio.slugify(text || "");
}

type MatchTeamsResult = {
  directHome: number;
  directAway: number;
  invertedHome: number;
  invertedAway: number;
  direct: number;
  inverted: number;
  swapped: boolean;
  score: number;
  compatible: boolean;
  /** Na orientação escolhida, um lado casou por evidência (`fixtureHasAnchorSide`). */
  anchored: boolean;
  /**
   * A evidência (`TeamSideSimilarity.evidence`) de cada lado da fixture contra o
   * time da aposta alinhado a ele, na orientação escolhida.
   */
  evidenceHome: number;
  evidenceAway: number;
};

type TeamPairParams = {
  betHome: string;
  betAway: string;
  fixtureHome: string;
  fixtureAway: string;
  betLeague?: string | null;
  fixtureLeague?: string | null;
};

function matchTeams(params: TeamPairParams, canonical: boolean): MatchTeamsResult {
  const [directHome, directAway, invertedHome, invertedAway, direct, inverted, swapped, score, compatible,
    anchored, evidenceHome, evidenceAway] = dominio.matchTeamsWithCategoryContext(
    params.betHome || "", params.betAway || "", params.fixtureHome || "", params.fixtureAway || "",
    params.betLeague, params.fixtureLeague, canonical,
  ) as [number, number, number, number, number, number, number, number, number, number, number, number];
  return {
    directHome, directAway, invertedHome, invertedAway, direct, inverted,
    swapped: swapped === 1, score, compatible: compatible === 1, anchored: anchored === 1,
    evidenceHome, evidenceAway,
  };
}

/**
 * Similaridade dos dois lados de um confronto nas duas orientações, com a
 * categoria lida também nas competições: a categoria que os dois lados
 * declaram sai da comparação de nomes, e orientação incompatível vale 0.
 */
export function matchTeamsWithCategoryContext(params: TeamPairParams): MatchTeamsResult {
  return matchTeams(params, false);
}

/**
 * Núcleo de `matchTeamsWithCategoryContext` para quem JÁ tem os nomes
 * canonicalizados: o laço contra o catálogo do dia canonicaliza a aposta uma vez.
 */
export function matchCanonTeamsWithCategoryContext(params: TeamPairParams): MatchTeamsResult {
  return matchTeams(params, true);
}

type CategoryCandidateFixture = {
  home: string;
  away: string;
  league?: string | null;
  /** País da competição; sem ele, a listagem em dobro não é presumida. */
  country?: string | null;
  kickoffMs: number;
  /** O candidato tem o mando trocado em relação ao post. */
  swapped: boolean;
};

/**
 * Depois da nota dos nomes, o que a categoria decide entre os candidatos:
 * 1. jogo de base nunca é candidato (`isBaseCategoryFixture`);
 * 2. sem categoria declarada no post (nome ou campeonato), o jogo principal
 *    vence o gêmeo de reserva ou feminino com os mesmos times, desde que não
 *    esteja com o mando pior que o dele nem mais longe do horário do post;
 * 3. o mesmo jogo listado duas vezes, até com o mando trocado, conta uma vez
 *    — só no provider sem id de time (Pinnacle, BridgeOdds).
 * Os candidatos chegam ordenados pela preferência do provider, e a ordem fica.
 */
export function refineCategoryCandidates<T>(params: {
  betHome: string;
  betAway: string;
  betLeague?: string | null;
  /** Horário do post; null quando é só o dia (horário inferido). */
  betKickoffMs?: number | null;
  candidates: readonly T[];
  fixture: (candidate: T) => CategoryCandidateFixture;
  /** Falso quando o provider tem id de time (FlashScore). */
  collapseDuplicateListings: boolean;
}): T[] {
  // A função de cada candidato fica do lado TS: a ponte recebe as colunas.
  const fixtures = params.candidates.map(params.fixture);
  const kept = dominio.refineCategoryCandidates(
    params.betHome || "", params.betAway || "", params.betLeague, params.betKickoffMs,
    params.collapseDuplicateListings,
    fixtures.map((f) => f.home || ""), fixtures.map((f) => f.away || ""),
    fixtures.map((f) => f.league ?? ""), fixtures.map((f) => f.country ?? ""),
    fixtures.map((f) => f.kickoffMs), fixtures.map((f) => (f.swapped ? 1 : 0)),
  );
  return kept.map((index) => params.candidates[index]!);
}

/**
 * O "R"/"Res" de reserva do tipster do futebol argentino nos DOIS times
 * ("Talleres R vs Gimnasia Mendoza R") vira "Reserva", que a categoria já
 * entende. Nos dois times, porque um só ("Bristol R" é o Rovers) não diz
 * reserva. Quem chama garante o futebol: no tênis a letra no fim é a inicial
 * do jogador ("Nadal R").
 */
export function markSoccerReserveTeams(bet: { evento: string; selecao: string }): { evento: string; selecao: string } {
  const marked = dominio.markSoccerReserveTeams(bet.evento ?? "", bet.selecao ?? "");
  return marked === null ? bet : { evento: marked[0], selecao: marked[1] };
}
