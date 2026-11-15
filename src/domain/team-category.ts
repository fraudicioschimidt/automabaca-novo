import {
  canonicalizeTeamName,
  isProtectedToken,
  normalizeStr,
  RESERVE_CLASS_MARKER,
  RESERVE_CLASS_TOKENS,
  teamNameVariants,
} from "./text-normalization";

/**
 * Categoria de time — feminino, base (sub-XX), reserva, time B e o sufixo
 * numérico de reserva ("River Plate 2") — e as travas que impedem juntar um
 * time de categoria ao principal. A categoria pode vir do nome do time ou da
 * competição ("Argentina - Liga Pro Reserves").
 *
 * O sufixo numérico não é token protegido: `teamSimilarity` também compara
 * seleções de aposta ("Canada Over 1.5"), onde o dígito não é categoria. Só
 * quem compara NOME DE TIME com NOME DE TIME o considera (`reserveSuffixMismatch`
 * e as travas de identidade). Só um dígito de 2 a 9: ano de fundação
 * ("Mainz 05", "Bayern 1900") continua compatível.
 */

/** Normaliza tokens protegidos para comparação (II ≡ Youth ≡ Reserves, mas B é distinto). */
export function protectedCategoryKey(token: string): string {
  return RESERVE_CLASS_TOKENS.has(token) ? RESERVE_CLASS_MARKER : token;
}

/**
 * Tokens que declaram a CATEGORIA do time — feminino, base, reserva, sufixo
 * numérico. Conjunto vazio = o nome não declara nada.
 */
export function teamCategoryTokens(canon: string, somenteDigitos = false): Set<string> {
  return new Set(
    canon
      .split(" ")
      .filter((t) => (somenteDigitos ? /^[2-9]$/.test(t) : isProtectedToken(t) || /^[2-9]$/.test(t)))
      .map(protectedCategoryKey),
  );
}

/** Os dois nomes (canônicos) divergem no sufixo numérico de reserva? */
export function reserveSuffixMismatch(ca: string, cb: string): boolean {
  const left = teamCategoryTokens(ca, true);
  const right = teamCategoryTokens(cb, true);
  return (
    [...left].some((t) => !right.has(t)) || [...right].some((t) => !left.has(t))
  );
}

function protectedCategorySet(canon: string): Set<string> {
  return new Set(
    canon.split(" ").filter(isProtectedToken).map(protectedCategoryKey),
  );
}

/** Os dois nomes (canônicos) divergem em algum token protegido? */
export function protectedCategoriesMismatch(ca: string, cb: string): boolean {
  const left = protectedCategorySet(ca);
  const right = protectedCategorySet(cb);
  return (
    [...left].some((token) => !right.has(token)) ||
    [...right].some((token) => !left.has(token))
  );
}

/** Impede que feminino, base, reservas ou time B sejam fundidos ao principal. */
export function hasProtectedTeamCategoryConflict(a: string, b: string): boolean {
  return protectedCategoriesMismatch(canonicalizeTeamName(a), canonicalizeTeamName(b));
}

/**
 * Conflito de categoria entre dois NOMES DE TIME: tokens protegidos OU sufixo
 * numérico de reserva (`River Plate 2` ≠ `River Plate`). Não usar contra
 * seleção de aposta — `Canada Over 1.5` tem dígitos e não é reserva.
 */
export function teamIdentityCategoryConflict(a: string, b: string): boolean {
  return (
    hasProtectedTeamCategoryConflict(a, b)
    || reserveSuffixMismatch(canonicalizeTeamName(a), canonicalizeTeamName(b))
  );
}

/**
 * A APOSTA declara uma categoria que a fixture do provider não declara nenhuma?
 *
 * Assimétrico de propósito. "Botafogo (F)" ou "River Plate 2" é informação que
 * o tipster deu; ignorá-la casaria o jogo feminino com o masculino. O inverso é
 * variação de NOME ("Celta Fortuna" é o "Celta Vigo II" do provider), e
 * recusá-lo só empurraria um casamento correto para a fila humana. Fixture que
 * declara ALGUMA categoria fica com a similaridade, que já a deixa em 0,35.
 */
export function betDeclaresCategoryFixtureLacks(
  canonAposta: string,
  canonFixture: string,
): boolean {
  if (teamCategoryTokens(canonAposta).size === 0) return false;
  return teamCategoryTokens(canonFixture).size === 0;
}

/**
 * Categoria declarada pela COMPETIÇÃO. A Pinnacle chama o reserva do Gimnasia
 * de "Gimnasia La Plata" e põe a categoria na liga ("Liga Pro Reserves").
 * Vocabulário próprio, sem algarismo nem numeral romano: "Liga II" e "Liga 2"
 * são segundas divisões, não ligas de reservas.
 */
const LEAGUE_CATEGORY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(reserves?|reservas?|next pro)\b/, RESERVE_CLASS_MARKER],
  [/\b(youth|academy|akatemia|akademia|primavera|juniors?|development)\b/, RESERVE_CLASS_MARKER],
  [/\b(women|womens|ladies|feminino|feminina|femenino|femenina|femminile|damen|dames)\b/, "women"],
];
const LEAGUE_AGE_GROUP = /\b(?:u|sub)[ -]?(\d{2})\b/g;

/**
 * Lida em laço contra o catálogo do dia, com poucas competições distintas: a
 * resposta de cada uma fica guardada, e o conjunto devolvido não se altera.
 */
const leagueTokens = new Map<string, ReadonlySet<string>>();
const LEAGUE_TOKENS_MAX = 2_000;

export function categoryTokensFromLeague(league: string): ReadonlySet<string> {
  const known = leagueTokens.get(league);
  if (known) return known;
  const texto = normalizeStr(league);
  const tokens = new Set<string>();
  for (const [padrao, token] of LEAGUE_CATEGORY_PATTERNS) if (padrao.test(texto)) tokens.add(token);
  for (const grupo of texto.matchAll(LEAGUE_AGE_GROUP)) tokens.add(protectedCategoryKey(`u${grupo[1]}`));
  if (leagueTokens.size >= LEAGUE_TOKENS_MAX) leagueTokens.clear();
  leagueTokens.set(league, tokens);
  return tokens;
}

/**
 * A LIGA da fixture cobre a categoria que a APOSTA declara?
 *
 * Só levanta a trava na direção em que ela cega: a aposta declara categoria e o
 * NOME da fixture não declara nada. O dígito solto ("River Plate 2") é coberto
 * por liga de reservas, não por liga feminina nem de base com idade.
 */
export function leagueCoversBetCategory(
  canonAposta: string,
  canonFixture: string,
  league: string | undefined,
): boolean {
  const aposta = teamCategoryTokens(canonAposta);
  if (aposta.size === 0) return false;
  if (teamCategoryTokens(canonFixture).size > 0) return false;
  const liga = categoryTokensFromLeague(league ?? "");
  if (liga.size === 0) return false;
  return [...aposta].every((token) =>
    liga.has(token) || (/^[2-9]$/.test(token) && liga.has(RESERVE_CLASS_MARKER)));
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
  const localAlignedHome = params.swapped ? params.localAway : params.localHome;
  const localAlignedAway = params.swapped ? params.localHome : params.localAway;
  const cProviderHome = canonicalizeTeamName(params.providerHome);
  const cProviderAway = canonicalizeTeamName(params.providerAway);
  const cLocalHome = canonicalizeTeamName(localAlignedHome);
  const cLocalAway = canonicalizeTeamName(localAlignedAway);

  const homeCovered = leagueCoversBetCategory(cLocalHome, cProviderHome, params.league);
  const awayCovered = leagueCoversBetCategory(cLocalAway, cProviderAway, params.league);

  return (
    (!homeCovered && reserveSuffixMismatch(cProviderHome, cLocalHome))
    || (!awayCovered && reserveSuffixMismatch(cProviderAway, cLocalAway))
  );
}

/**
 * Remove tokens de categoria já satisfeitos pelo contexto da liga, para que a
 * comparação de nomes avalie os radicais distintivos dos times.
 */
export function stripCategoryTokens(canonName: string, tokensToStrip: ReadonlySet<string>): string {
  if (!canonName || tokensToStrip.size === 0) return canonName;
  const words = canonName.split(" ").filter(Boolean);
  const filtered = words.filter((word) => {
    const key = protectedCategoryKey(word);
    if (tokensToStrip.has(key) || tokensToStrip.has(word)) return false;
    if (/^[2-9]$/.test(word) && (tokensToStrip.has(word) || tokensToStrip.has(RESERVE_CLASS_MARKER))) {
      return false;
    }
    return true;
  });
  return filtered.length > 0 ? filtered.join(" ").trim() : canonName;
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
  const betTeamTokens = teamCategoryTokens(params.betCanon);
  const fixTeamTokens = teamCategoryTokens(params.fixtureCanon);
  const betLeagueTokens = categoryTokensFromLeague(params.betLeague ?? "");
  const fixLeagueTokens = categoryTokensFromLeague(params.fixtureLeague ?? "");

  const betAllTokens = new Set([...betTeamTokens, ...betLeagueTokens]);
  const fixAllTokens = new Set([...fixTeamTokens, ...fixLeagueTokens]);

  // Feminino: aposta feminina exige fixture feminina; fixture feminina contra
  // aposta que declara outra competição também não casa.
  const betIsWomen = betAllTokens.has("women");
  const fixIsWomen = fixAllTokens.has("women");
  if (betIsWomen && !fixIsWomen) {
    return { compatible: false, coveredTokens: new Set() };
  }
  if (fixIsWomen && !betIsWomen) {
    if (params.betLeague && params.betLeague.trim().length > 0) {
      return { compatible: false, coveredTokens: new Set() };
    }
  }

  const coveredTokens = new Set<string>();
  if (betIsWomen && fixIsWomen) {
    coveredTokens.add("women");
  }

  // Idades declaradas dos dois lados precisam ter uma em comum.
  const betAges = [...betAllTokens].filter((t) => /^u\d{2}$/.test(t));
  const fixAges = [...fixAllTokens].filter((t) => /^u\d{2}$/.test(t));
  if (betAges.length > 0 && fixAges.length > 0) {
    const hasCommonAge = betAges.some((a) => fixAges.includes(a));
    if (!hasCommonAge) {
      return { compatible: false, coveredTokens: new Set() };
    }
    for (const a of betAges) {
      if (fixAges.includes(a)) coveredTokens.add(a);
    }
  }

  // Reservas e dígitos cobertos pela liga do outro lado: a da fixture cobre o
  // que o nome da aposta declara, e a da aposta cobre o que o nome da fixture
  // declara ("Gimnasia La Plata" na "Liga Pro Reserves" é o "Gimnasia L.P. 2").
  const covered = [
    ...(leagueCoversBetCategory(params.betCanon, params.fixtureCanon, params.fixtureLeague ?? undefined)
      ? betTeamTokens : []),
    ...(leagueCoversBetCategory(params.fixtureCanon, params.betCanon, params.betLeague ?? undefined)
      ? fixTeamTokens : []),
  ];
  for (const t of covered) {
    coveredTokens.add(t);
    if (/^[2-9]$/.test(t)) coveredTokens.add(RESERVE_CLASS_MARKER);
  }

  // A mesma categoria declarada no nome dos dois times.
  for (const t of betTeamTokens) {
    if (fixTeamTokens.has(t)) {
      coveredTokens.add(t);
    }
  }

  // Liga de reservas na fixture contra aposta que declara outra competição e
  // nenhuma categoria.
  if (fixLeagueTokens.has(RESERVE_CLASS_MARKER) && betAllTokens.size === 0 && params.betLeague?.trim()) {
    return { compatible: false, coveredTokens: new Set() };
  }
  // E o espelho: aposta de liga de reservas ou de base contra fixture de liga
  // conhecida em que nem os nomes nem a competição declaram categoria. "River
  // Plate" na "Liga Pro Reserves" não é o River Plate do Profesional, e o
  // "Chelsea" da Youth League não é o da Premier League.
  const betLeagueReserveOrAge = [...betLeagueTokens].some((t) => t === RESERVE_CLASS_MARKER || /^u\d{2}$/.test(t));
  if (betLeagueReserveOrAge && betTeamTokens.size === 0 && fixAllTokens.size === 0 && params.fixtureLeague?.trim()) {
    return { compatible: false, coveredTokens: new Set() };
  }

  return { compatible: true, coveredTokens };
}

/**
 * Conflito de categoria entre o time da aposta e o da fixture, lendo também as
 * competições: é `teamIdentityCategoryConflict` depois de tirar a categoria que
 * as ligas explicam. "Chelsea" na "Champions League Women" é o "Chelsea W" do
 * FlashScore; sem liga, os dois continuam times diferentes. A forma
 * equivalente do dicionário também tira o conflito: o "Porto II" da Pinnacle é
 * o "FC Porto B" do FlashScore, e o Club NXT é o Club Brugge II.
 */
export function teamCategoryConflictInContext(params: {
  betName: string;
  fixtureName: string;
  betLeague?: string | null;
  fixtureLeague?: string | null;
}): boolean {
  const betCanon = canonicalizeTeamName(params.betName);
  const fixtureCanon = canonicalizeTeamName(params.fixtureName);
  const category = areCategoriesCompatible({
    betCanon,
    fixtureCanon,
    betLeague: params.betLeague,
    fixtureLeague: params.fixtureLeague,
  });
  if (!category.compatible) return true;
  const bet = stripCategoryTokens(betCanon, category.coveredTokens);
  const fixture = stripCategoryTokens(fixtureCanon, category.coveredTokens);
  const conflict = (a: string, b: string) => protectedCategoriesMismatch(a, b) || reserveSuffixMismatch(a, b);
  if (!conflict(bet, fixture)) return false;
  const fixtureForms = [fixture, ...teamNameVariants(fixture)];
  return [bet, ...teamNameVariants(bet)].every((a) => fixtureForms.every((b) => conflict(a, b)));
}

/**
 * A categoria de um time: a que o NOME declara ou, se ele não declara nenhuma,
 * a da COMPETIÇÃO — a Pinnacle escreve "Chelsea" e põe o feminino na liga. O
 * sufixo numérico conta como a classe reserva, que é o que a liga declara.
 */
export function teamCategoryInContext(name: string, league?: string | null): ReadonlySet<string> {
  const doNome = [...teamCategoryTokens(canonicalizeTeamName(name))]
    .map((token) => (/^[2-9]$/.test(token) ? RESERVE_CLASS_MARKER : token));
  return doNome.length > 0 ? new Set(doNome) : categoryTokensFromLeague(league ?? "");
}

export function sameTeamCategory(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((token) => b.has(token));
}

/**
 * Base = competição de idade (sub-15 a sub-23, Youth, Primavera, juvenis, a
 * Copinha) ou time sub-15 a sub-20. Time sub-21/sub-23 em liga adulta é reserva
 * e vale: Genk II ("Genk U23") na Challenger Pro League, Atalanta U23 e Juventus
 * Next Gen na Série C, Tottenham U21 no EFL Trophy. As casas brasileiras não oferecem (Lei
 * 14.790/2023) e o dono só segue tipsters brasileiros, então jogo de base nunca
 * é candidato: sem esta trava, o gêmeo sub-19 da Champions (UEFA Youth League,
 * mesmos nomes na Pinnacle) empata com o jogo principal. Reserva (B, II, Jong,
 * Reserves, Next Pro) e feminino não são base. O `ageLimit` da Pinnacle17 não
 * serve: ele marca também a Liga Pro Reserves argentina, que os tipsters apostam.
 */
const BASE_LEAGUE = /\b(?:(?:u|sub)[ -]?(?:1[5-9]|2[0-3])|youth|primavera|juvenil(?:es)?|juniores|futebol junior)\b/;
const BASE_TEAM_TOKEN = /^u(?:1[5-9]|20)$/;

export function isBaseCategoryFixture(params: { home: string; away: string; league?: string | null }): boolean {
  if (BASE_LEAGUE.test(normalizeStr(params.league ?? ""))) return true;
  return [params.home, params.away].some((name) =>
    canonicalizeTeamName(name).split(" ").some((token) => BASE_TEAM_TOKEN.test(token)));
}
