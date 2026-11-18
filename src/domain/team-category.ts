import dominio from "@automabaca/dominio";

/**
 * Categoria de time — feminino, base (sub-XX), reserva, time B e o sufixo
 * numérico de reserva ("River Plate 2") — e as travas que impedem juntar um
 * time de categoria ao principal. A categoria pode vir do nome do time ou da
 * competição ("Argentina - Liga Pro Reserves"). A regra mora em Rust
 * (`rust/crates/dominio/src/team_category.rs`).
 *
 * O sufixo numérico não é token protegido: `teamSimilarity` também compara
 * seleções de aposta ("Canada Over 1.5"), onde o dígito não é categoria. Só
 * quem compara NOME DE TIME com NOME DE TIME o considera.
 */

/** Normaliza tokens protegidos para comparação (II ≡ Youth ≡ Reserves, mas B é distinto). */
export function protectedCategoryKey(token: string): string {
  return dominio.protectedCategoryKey(token);
}

/**
 * Tokens que declaram a CATEGORIA do time — feminino, base, reserva, sufixo
 * numérico. Conjunto vazio = o nome não declara nada.
 */
export function teamCategoryTokens(canon: string, somenteDigitos = false): Set<string> {
  return new Set(dominio.teamCategoryTokens(canon, somenteDigitos));
}

/** Os dois nomes (canônicos) divergem no sufixo numérico de reserva? */
export function reserveSuffixMismatch(ca: string, cb: string): boolean {
  return dominio.reserveSuffixMismatch(ca, cb);
}

/** Os dois nomes (canônicos) divergem em algum token protegido? */
export function protectedCategoriesMismatch(ca: string, cb: string): boolean {
  return dominio.protectedCategoriesMismatch(ca, cb);
}

/** Impede que feminino, base, reservas ou time B sejam fundidos ao principal. */
export function hasProtectedTeamCategoryConflict(a: string, b: string): boolean {
  return dominio.hasProtectedTeamCategoryConflict(a || "", b || "");
}

/**
 * Conflito de categoria entre dois NOMES DE TIME: tokens protegidos OU sufixo
 * numérico de reserva (`River Plate 2` ≠ `River Plate`). Não usar contra
 * seleção de aposta — `Canada Over 1.5` tem dígitos e não é reserva.
 */
export function teamIdentityCategoryConflict(a: string, b: string): boolean {
  return dominio.teamIdentityCategoryConflict(a || "", b || "");
}

/**
 * A APOSTA declara uma categoria que a fixture do provider não declara nenhuma?
 * Assimétrico de propósito: "Botafogo (F)" é informação que o tipster deu; o
 * inverso é variação de nome.
 */
export function betDeclaresCategoryFixtureLacks(canonAposta: string, canonFixture: string): boolean {
  return dominio.betDeclaresCategoryFixtureLacks(canonAposta, canonFixture);
}

// Lida em laço contra o catálogo do dia, com poucas competições distintas: a
// resposta de cada uma fica guardada (uma travessia da ponte por competição), e
// o conjunto devolvido não se altera.
const leagueTokens = new Map<string, ReadonlySet<string>>();
const LEAGUE_TOKENS_MAX = 2_000;

/** Categoria declarada pela COMPETIÇÃO ("Liga Pro Reserves", "Champions League Women"). */
export function categoryTokensFromLeague(league: string): ReadonlySet<string> {
  const known = leagueTokens.get(league);
  if (known) return known;
  const tokens: ReadonlySet<string> = new Set(dominio.categoryTokensFromLeague(league ?? ""));
  if (leagueTokens.size >= LEAGUE_TOKENS_MAX) leagueTokens.clear();
  leagueTokens.set(league, tokens);
  return tokens;
}

/**
 * A LIGA da fixture cobre a categoria que a APOSTA declara? Só levanta a trava
 * na direção em que ela cega: a aposta declara e o NOME da fixture não declara nada.
 */
export function leagueCoversBetCategory(
  canonAposta: string,
  canonFixture: string,
  league: string | undefined,
): boolean {
  return dominio.leagueCoversBetCategory(canonAposta, canonFixture, league);
}

/**
 * Sufixo numérico de reserva nos dois lados já orientados (casa/fora), salvo
 * quando a liga da fixture cobre a categoria. Chame depois de decidir `swapped`.
 */
export function orientedTeamPairHasReserveSuffixConflict(params: {
  providerHome: string;
  providerAway: string;
  localHome: string;
  localAway: string;
  swapped: boolean;
  league?: string;
}): boolean {
  return dominio.orientedTeamPairHasReserveSuffixConflict(
    params.providerHome || "", params.providerAway || "", params.localHome || "", params.localAway || "",
    params.swapped, params.league,
  );
}

/**
 * Remove tokens de categoria já satisfeitos pelo contexto da liga, para que a
 * comparação de nomes avalie os radicais distintivos dos times.
 */
export function stripCategoryTokens(canonName: string, tokensToStrip: ReadonlySet<string>): string {
  return dominio.stripCategoryTokens(canonName, [...tokensToStrip]);
}

type CategoryCompatibility = {
  compatible: boolean;
  coveredTokens: Set<string>;
};

/**
 * Compatibilidade de categoria entre o time da aposta e o da fixture, lendo os
 * nomes dos times e das competições. `coveredTokens` são as categorias que os
 * dois lados declaram e que a comparação de nomes pode ignorar.
 */
export function areCategoriesCompatible(params: {
  betCanon: string;
  fixtureCanon: string;
  betLeague?: string | null;
  fixtureLeague?: string | null;
}): CategoryCompatibility {
  const [compatible, covered] = dominio.areCategoriesCompatible(
    params.betCanon, params.fixtureCanon, params.betLeague, params.fixtureLeague,
  );
  return { compatible, coveredTokens: new Set(covered) };
}

/**
 * Conflito de categoria entre o time da aposta e o da fixture, lendo também as
 * competições, e sem conflito quando a forma equivalente do dicionário o tira
 * (o "Porto II" da Pinnacle é o "FC Porto B" do FlashScore).
 */
export function teamCategoryConflictInContext(params: {
  betName: string;
  fixtureName: string;
  betLeague?: string | null;
  fixtureLeague?: string | null;
}): boolean {
  return dominio.teamCategoryConflictInContext(
    params.betName || "", params.fixtureName || "", params.betLeague, params.fixtureLeague,
  );
}

/**
 * A categoria de um time: a que o NOME declara ou, se ele não declara nenhuma,
 * a da COMPETIÇÃO — a Pinnacle escreve "Chelsea" e põe o feminino na liga.
 */
export function teamCategoryInContext(name: string, league?: string | null): ReadonlySet<string> {
  return new Set(dominio.teamCategoryInContext(name || "", league));
}

export function sameTeamCategory(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return dominio.sameTeamCategory([...a], [...b]);
}

/**
 * Base = competição de idade ou time sub-15 a sub-20: jogo de base nunca é
 * candidato (as casas brasileiras não oferecem, Lei 14.790/2023).
 */
export function isBaseCategoryFixture(params: { home: string; away: string; league?: string | null }): boolean {
  return dominio.isBaseCategoryFixture(params.home || "", params.away || "", params.league);
}
