import {
  canonicalizeTeamName,
  isProtectedToken,
  normalizeStr,
  RESERVE_CLASS_MARKER,
  RESERVE_CLASS_TOKENS,
  TEAM_STOP_WORDS,
  teamNameVariants,
} from "./text-normalization";
import {
  areCategoriesCompatible,
  categoryTokensFromLeague,
  isBaseCategoryFixture,
  protectedCategoriesMismatch,
  stripCategoryTokens,
  teamCategoryInContext,
  teamCategoryTokens,
  teamIdentityCategoryConflict,
} from "./team-category";

/**
 * Texto de aposta e de provider para matching: similaridade de nomes de time,
 * separação "A vs B" e slug. A normalização mora em `text-normalization.ts` e
 * as travas de categoria em `team-category.ts`; este módulo reexporta as duas
 * para que o resto do projeto importe tudo de um lugar.
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

// As funções "FromCanon" recebem o nome já canonicalizado, para
// `teamSimilarity` canonicalizar cada lado uma vez só.
function charBigramsFromCanon(canon: string): Set<string> {
  const clean = canon.replace(/\s+/g, "");
  const grams = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) {
    grams.add(clean.slice(i, i + 2));
  }
  return grams;
}

function diceFromGrams(ga: Set<string>, gb: Set<string>): number {
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  ga.forEach((g) => {
    if (gb.has(g)) inter++;
  });
  return (2 * inter) / (ga.size + gb.size);
}

/**
 * Similaridade híbrida 0..1 entre nomes de time: containment + jaccard +
 * dice (bigramas), com boost para subconjunto pleno de tokens distintivos
 * ("Bayern" ⊂ "Bayern Munich" → ≥0.9) e substring canônica direta (≥0.85).
 * "Real Madrid" vs "Real Betis" fica baixo ("real" é stop-word).
 */
export function teamSimilarity(a: string, b: string): number {
  return teamSimilarityCanon(canonicalizeTeamName(a), canonicalizeTeamName(b));
}

/** Token set para similaridade: II/Youth/B contam como a mesma classe reserva. */
function tokenSetForSimilarity(canon: string): Set<string> {
  return new Set(
    canon
      .split(" ")
      .filter(Boolean)
      .map((t) => (RESERVE_CLASS_TOKENS.has(t) ? RESERVE_CLASS_MARKER : t)),
  );
}

type NameFeatures = { tokens: Set<string>; grams: Set<string> };
const FEATURE_CACHE_LIMIT = 20_000;
const featureCache = new Map<string, NameFeatures>();

/**
 * Tokens e bigramas de um nome canônico, guardados: o laço contra o catálogo
 * compara o mesmo nome do fornecedor com cada aposta e com cada forma do
 * dicionário. Quem recebe não altera os conjuntos.
 */
function nameFeatures(canon: string): NameFeatures {
  const cached = featureCache.get(canon);
  if (cached) return cached;
  const features = { tokens: tokenSetForSimilarity(canon), grams: charBigramsFromCanon(canon) };
  if (featureCache.size >= FEATURE_CACHE_LIMIT) featureCache.clear();
  featureCache.set(canon, features);
  return features;
}

/**
 * Semelhança de um lado do confronto. `score` é o que soma no par; `evidence`
 * é a parte que pode ANCORAR o par (`ANCHOR_SIDE_FLOOR`): tudo menos o resgate
 * de digitação, que acha "Juventus" em "Juventud" (0,88) e por isso só
 * acompanha um lado que casou por outra razão.
 */
export type TeamSideSimilarity = { score: number; evidence: number };

const NO_SIMILARITY: TeamSideSimilarity = { score: 0, evidence: 0 };
const SAME_NAME: TeamSideSimilarity = { score: 1, evidence: 1 };

/**
 * Núcleo de `teamSimilarity` para quem JÁ tem os nomes canonicalizados: laços
 * que comparam a aposta contra N candidatos canonicalizam o lado fixo uma vez.
 * String não canônica aqui dá resultado errado.
 */
export function teamSimilarityCanon(ca: string, cb: string): number {
  return teamSideSimilarityCanon(ca, cb).score;
}

/**
 * `teamSimilarityCanon` com a evidência de âncora. Vale o melhor entre os
 * nomes como vieram e as formas equivalentes do dicionário
 * (`teamNameVariants`: "Bayern de Munique" × "Bayern Munich", "Atlético-MG" ×
 * "Atletico Mineiro", "Villarreal B" × "Villarreal II").
 */
export function teamSideSimilarityCanon(ca: string, cb: string): TeamSideSimilarity {
  const direct = rawSideSimilarity(ca, cb, true);
  if (direct.evidence === 1) return direct;
  const variantsA = teamNameVariants(ca);
  const variantsB = teamNameVariants(cb);
  const initialsA = expandInitials(ca, cb);
  const initialsB = expandInitials(cb, ca);
  if (variantsA.length === 0 && variantsB.length === 0 && !initialsA && !initialsB) return direct;
  let { score, evidence } = direct;
  // A forma do dicionário e a inicial expandida valem como estão: digitação em
  // cima delas acharia parentes que o nome original não tem ("Internazionale" ×
  // "Internacional").
  const consider = (a: string, b: string) => {
    const side = rawSideSimilarity(a, b, false);
    score = Math.max(score, side.score);
    evidence = Math.max(evidence, side.evidence);
  };
  for (const a of [ca, ...variantsA]) {
    for (const b of [cb, ...variantsB]) {
      if (a !== ca || b !== cb) consider(a, b);
    }
  }
  // A forma expandida fica abaixo do nome igual: no clássico "Rad Beograd" ×
  // "Radnicki Beograd" o nome igual decide o mando. Só a inicial de uma letra
  // ancora; a abreviação de 2 ou 3 letras soma como a digitação ("Nes" ×
  // "Ness").
  for (const [expanded, a, b] of [[initialsA, initialsA?.name, cb], [initialsB, ca, initialsB?.name]] as const) {
    if (!expanded || !a || !b) continue;
    const side = rawSideSimilarity(a, b, false);
    score = Math.max(score, Math.min(side.score, EXPANDED_CAP));
    if (!expanded.prefix) evidence = Math.max(evidence, Math.min(side.evidence, EXPANDED_CAP));
  }
  return { score, evidence };
}

const EXPANDED_CAP = 0.95;

/** Letra solta que é categoria, não inicial: B (reserva), W e F (feminino). */
const CATEGORY_LETTERS = new Set(["b", "w", "f"]);
const SHORT_WORD = /(?:^| )[a-z]{1,3}(?: |$)/;
const JOINERS = new Set(["de", "del", "da", "do", "dos", "das", "e", "y"]);
/** Sigla de estado brasileiro no fim do nome não é abreviação ("Botafogo SP" ≠ "Botafogo Sport"). */
const BRAZILIAN_STATES = new Set([
  "ac", "al", "ap", "am", "ba", "ce", "df", "es", "go", "ma", "mt", "ms", "mg", "pa", "pb", "pr", "pe", "pi",
  "rj", "rn", "rs", "ro", "rr", "sc", "sp", "se", "to",
]);
/** Palavra comum demais para confirmar a abreviação ("M. City" serve a Manchester e a Melbourne). */
const GENERIC_SUPPORT = new Set([
  "city", "united", "town", "county", "rovers", "wanderers", "athletic", "athletico", "sport", "sports",
  "juniors", "rangers", "albion", "calcio",
]);

/**
 * "A. Italiano" = "Audax Italiano", "Sp. Luqueno" = "Sportivo Luqueno": o
 * FlashScore abrevia uma palavra pelo começo ("I. Bratislava", "U. Catolica",
 * "San Martin S.J."). Troca cada abreviação de `a` pela próxima palavra de `b`
 * que começa com ela, na mesma ordem, desde que uma palavra distintiva seja
 * igual nos dois lados; se alguma abreviação não acha palavra, não expande (o
 * token que sobra pode ser o que distingue o time). Letra solta no fim do
 * nome só vale junto de outra inicial: sozinha é a marca de reserva do tipster
 * ("Talleres R"). `prefix` diz se usou abreviação de 2 ou 3 letras.
 */
function expandInitials(a: string, b: string): { name: string; prefix: boolean } | null {
  if (!SHORT_WORD.test(a)) return null;
  const wordsA = a.split(" ");
  const wordsB = b.split(" ").filter((word) => !JOINERS.has(word));
  const isAbbreviation = (word: string, index: number) => {
    if (JOINERS.has(word) || wordsB.includes(word)) return false;
    // A sigla de estado vem no fim ("Botafogo SP"); no começo é abreviação ("Sp. Luqueno").
    if (BRAZILIAN_STATES.has(word) && index === wordsA.length - 1) return false;
    if (word.length === 1) {
      return !CATEGORY_LETTERS.has(word) && (index < wordsA.length - 1 || wordsA[index - 1]?.length === 1);
    }
    return word.length <= 3 && /^[a-z]+$/.test(word) && !TEAM_STOP_WORDS.has(word) && !isProtectedToken(word);
  };
  if (!wordsA.some(isAbbreviation)) return null;
  const supported = wordsA.some((word) => word.length > 2 && !TEAM_STOP_WORDS.has(word)
    && !GENERIC_SUPPORT.has(word) && wordsB.includes(word));
  if (!supported) return null;
  const out: string[] = [];
  let next = 0;
  let prefix = false;
  for (const [index, word] of wordsA.entries()) {
    const at = wordsB.indexOf(word, next);
    if (at >= 0 || !isAbbreviation(word, index)) {
      if (at >= 0) next = at + 1;
      out.push(word);
      continue;
    }
    let found = next;
    while (found < wordsB.length && !(wordsB[found]!.length > word.length && wordsB[found]!.startsWith(word))) found += 1;
    if (found >= wordsB.length) return null;
    out.push(wordsB[found]!);
    next = found + 1;
    prefix ||= word.length > 1;
  }
  return { name: out.join(" "), prefix };
}

/** A evidência de um par de nomes (sem o resgate de digitação), para a confiança de alias. */
export function teamNameEvidence(a: string, b: string): number {
  return teamSideSimilarityCanon(canonicalizeTeamName(a), canonicalizeTeamName(b)).evidence;
}

function rawSideSimilarity(ca: string, cb: string, typoRescue: boolean): TeamSideSimilarity {
  if (!ca || !cb) return NO_SIMILARITY;
  if (ca === cb) return SAME_NAME;

  const featuresA = nameFeatures(ca);
  const featuresB = nameFeatures(cb);
  const ta = featuresA.tokens;
  const tb = featuresB.tokens;
  const protectedMismatch = protectedCategoriesMismatch(ca, cb);
  let inter = 0;
  ta.forEach((w) => {
    if (tb.has(w)) inter++;
  });
  const union = ta.size + tb.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;
  const containment = inter / Math.max(1, Math.min(ta.size, tb.size));
  const dice = diceFromGrams(featuresA.grams, featuresB.grams);

  const smaller = ta.size <= tb.size ? ta : tb;
  const distinctive = [...smaller].some(
    (t) => t.length > 2 && !TEAM_STOP_WORDS.has(t) && t !== RESERVE_CLASS_MARKER,
  );
  const evidenceOnly = (score: number): TeamSideSimilarity => {
    const capped = protectedMismatch ? Math.min(score, 0.35) : score;
    return { score: capped, evidence: capped };
  };
  if (containment >= 0.999 && distinctive) return evidenceOnly(Math.max(0.9, 0.6 * dice + 0.4));
  const fa = ca.replace(/\s+/g, "");
  const fb = cb.replace(/\s+/g, "");
  if ((fa.includes(fb) || fb.includes(fa)) && Math.min(fa.length, fb.length) >= 4) {
    return evidenceOnly(Math.max(0.85, 0.5 * dice + 0.4));
  }

  const score = 0.45 * jaccard + 0.3 * dice + 0.25 * containment;
  if (protectedMismatch) return evidenceOnly(score);
  // Resgate de erro de digitação: um typo dentro da palavra zera jaccard e
  // containment ("Sherewsbury" × "Shrewsbury" = 0,25), e a distância de edição
  // vê o que o token não vê. Só sobe o escore, e só acima do piso; não conta
  // como evidência de âncora.
  return { score: typoRescue ? Math.max(score, typoRescueScore(ca, cb)) : score, evidence: score };
}

/**
 * Piso do lado ÂNCORA de um confronto, sobre a `evidence` do lado: uma
 * ramificação de evidência (igualdade, dicionário, containment ≥0,9, substring
 * ≥0,85) ou a mistura jaccard/dice, que é semelhança de TEXTO. O resgate de
 * digitação soma no par, mas não ancora. Um par pode ter um lado fraco
 * (apelido, patrocinador), mas não os dois: aí nada afirma identidade.
 */
export const ANCHOR_SIDE_FLOOR = 0.5;

/**
 * O par tem um lado âncora? Chame ANTES de aceitar candidato por soma de lados.
 * Recebe as EVIDÊNCIAS dos lados (`TeamSideSimilarity.evidence`) JÁ orientados
 * (depois de decidir `swapped`) — comparar o lado errado responderia outra
 * pergunta, e o escore com o resgate de digitação deixaria "Juventud" ancorar
 * "Juventus".
 */
export function fixtureHasAnchorSide(homeEvidence: number, awayEvidence: number): boolean {
  return Math.max(homeEvidence, awayEvidence) >= ANCHOR_SIDE_FLOOR;
}

/**
 * Piso do resgate. Medido: pares com typo ≥0,909; há pares distintos acima
 * dele ("FK Partizan" × "Partizani" 0,889), por isso a digitação não ancora.
 */
const TYPO_RESCUE_FLOOR = 0.85;

/** Forma jurídica e artigo: não distinguem um time na comparação de digitação. */
const TYPO_IGNORED_TOKENS = new Set(["fc", "sc", "ca", "fk", "sk", "club", "de", "da", "do", "del", "the", "ac", "cf", "bk", "if"]);

/**
 * Similaridade por distância de edição, só para quase-idênticos. A forma
 * jurídica que só um lado tem sai ("FK Zeleznicar Pancovo" × "Zeleznicar
 * Pancevo"); formas diferentes nos dois lados ficam ("Barcelona SC" ≠ "FC
 * Barcelona"). Letras invertidas contam uma edição ("Astrops" × "Astorps").
 */
function typoRescueScore(ca: string, cb: string): number {
  const direct = typoRatio(ca, cb);
  if (direct > 0) return direct;
  const withoutLegalForm = (canon: string) => canon.split(" ").filter((word) => !TYPO_IGNORED_TOKENS.has(word)).join(" ");
  const sa = withoutLegalForm(ca);
  const sb = withoutLegalForm(cb);
  return (sa !== ca) !== (sb !== cb) ? typoRatio(sa, sb) : 0;
}

/** Devolve 0 quando não alcança o piso — assim `Math.max` no chamador ignora. */
function typoRatio(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  // Pré-filtro barato: roda em laço contra o catálogo do dia; se a diferença de
  // tamanho já impede alcançar o piso, nem calcula a matriz.
  if (1 - Math.abs(a.length - b.length) / longest < TYPO_RESCUE_FLOOR) return 0;
  const similarity = 1 - editDistance(a, b) / longest;
  return similarity >= TYPO_RESCUE_FLOOR ? similarity : 0;
}

/**
 * Distância de edição em que a inversão de duas letras vizinhas custa 1
 * (Damerau restrita), com três linhas em vez da matriz inteira.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let beforePrevious = new Array<number>(b.length + 1).fill(0);
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, beforePrevious[j - 2]! + 1);
      }
      current[j] = best;
    }
    [beforePrevious, previous, current] = [previous, current, beforePrevious];
  }
  return previous[b.length]!;
}

/** Melhor token para busca textual em provider (mais distintivo/longo). */
export function bestSearchWord(s: string): string {
  const canon = canonicalizeTeamName(s);
  const words = canon.split(/\s+/).filter(Boolean);
  if (words.length === 0) return normalizeStr(s);
  const meaningful = words.filter(
    (w) =>
      w.length > 2 &&
      !TEAM_STOP_WORDS.has(w) &&
      !/^\d+$/.test(w) &&
      !isProtectedToken(w),
  );
  if (meaningful.length > 0) {
    return meaningful.reduce((a, b) => (b.length > a.length ? b : a));
  }
  // Se só restaram descritores genéricos ("Team 1", "Equipe A"), nunca os
  // envie como filtro. Um token curto/número ainda é ruim, mas restringe mais
  // que a palavra "team"; vazio deixa o caller consultar o catálogo do dia.
  const nongeneric = words.filter(
    (w) => !TEAM_STOP_WORDS.has(w) && !isProtectedToken(w),
  );
  const pool = nongeneric.length > 0 ? nongeneric : [];
  return pool.reduce((a, b) => (b.length > a.length ? b : a), pool[0] ?? "");
}

/**
 * Divide "Time A vs Time B" em casa/fora, tolerando os delimitadores comuns
 * (vs, v, versus, x, hífen, travessões). Null quando não é um confronto.
 */
export function splitEventoTeams(
  evento: string | null | undefined,
): { home: string; away: string } | null {
  const compact = (evento ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return null;

  // Delimitadores em ordem de FORÇA: "vs/versus", " x " e " / " separam
  // confronto; hífen e travessão também aparecem DENTRO de nomes ("Red Bull -
  // Salzburg"). `vs` vem antes de `v` ("FC V vs Team B") e `x` minúsculo antes
  // do maiúsculo ("Team X x Team Y"); X e V maiúsculos só valem com o evento
  // todo em caixa alta, caso comum dos canais BR.
  const stateSuffixesAroundHyphen =
    /^.+\/[a-z]{2}\s+[-–—]\s+.+\/[a-z]{2}(?:\s+[-–—]\s+.*)?$/i.test(compact);
  const delimitadores: Array<{ pattern: RegExp; gluedSlash?: boolean }> = [
    { pattern: /\s+(?:vs\.?|versus)\s+/i },
    { pattern: /\s+x\s+/ },
    ...(compact === compact.toUpperCase() ? [{ pattern: /\s+X\s+/ }] : []),
    { pattern: /\s+\/\s+/ },
    ...(stateSuffixesAroundHyphen ? [{ pattern: /\s+[-–—]\s+/ }] : []),
    { pattern: /(?<=\S)\/(?=\S)/, gluedSlash: true },
    { pattern: /\s+v\.?\s+/ },
    ...(compact === compact.toUpperCase() ? [{ pattern: /\s+V\.?\s+/ }] : []),
    ...(!stateSuffixesAroundHyphen ? [{ pattern: /\s+[-–—]\s+/ }] : []),
  ];
  for (const { pattern, gluedSlash } of delimitadores) {
    const m = compact.match(pattern);
    if (!m || m.index === undefined) continue;
    const home = compact.slice(0, m.index).trim();
    let away = compact.slice(m.index + m[0].length).trim();
    // Sufixo de rodada polui o visitante em qualquer delimitador:
    // "Time A - Time B - 15ª rodada".
    away = away.replace(
      /\s+[-–—]\s+(?:(?:\d+[ªºa.]*)\s*)?(?:(?:rodada|round|jornada|matchday)\b|[rj]\.?(?=\s|$)).*$/i,
      "",
    ).trim();
    if (gluedSlash) {
      const homeSize = home.replace(/[^a-z0-9]/gi, "").length;
      const awaySize = away.replace(/[^a-z0-9]/gi, "").length;
      if (homeSize < 2 || awaySize < 2) continue;
    }
    if (home && away) return { home, away };
  }
  return null;
}

const PLACEHOLDER_OPPONENT = /\b(?:adversario|opponent|tbd|a definir)\b|\.{3}|…/;
const LINE_AS_TEAM = /^[+-]?\s*\d+(?:[.,]\d+)?(?:\s*(?:ha|ah|handicap|ml|pts?|pontos?))?$/i;

/** Adversário inventado ou cortado, ou uma linha no lugar de um dos times:
 * “Blumenau -48.5 HA” não nomeia o adversário. */
export function fixtureHasPlaceholderTeam(evento: string): boolean {
  if (PLACEHOLDER_OPPONENT.test(normalizeStr(evento))) return true;
  const teams = splitEventoTeams(evento);
  return Boolean(teams && [teams.home, teams.away].some((team) => LINE_AS_TEAM.test(team.trim())));
}

/**
 * Limiar único de "é o MESMO confronto, só com outro alias dos times": a edição
 * pelo painel e a edição no canal decidem a mesma pergunta.
 */
export const SAME_FIXTURE_MIN_SIMILARITY = 0.85;

/**
 * Os dois eventos descrevem o mesmo confronto? Compara mandante com mandante e
 * visitante com visitante; qualquer lado abaixo do limiar já reprova. Null em
 * qualquer um dos lados (não é confronto) também reprova.
 */
export function sameFixtureTeams(
  eventoA: string | null | undefined,
  eventoB: string | null | undefined,
): boolean {
  const a = splitEventoTeams(eventoA);
  const b = splitEventoTeams(eventoB);
  if (!a || !b) return false;
  if (teamIdentityCategoryConflict(a.home, b.home) || teamIdentityCategoryConflict(a.away, b.away)) {
    return false;
  }
  return (
    teamSimilarity(a.home, b.home) >= SAME_FIXTURE_MIN_SIMILARITY &&
    teamSimilarity(a.away, b.away) >= SAME_FIXTURE_MIN_SIMILARITY
  );
}

/** "Tipster João" → "tipster-joao" (slug de URL). */
export function slugify(text: string): string {
  return normalizeStr(text)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
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

type CategoryLeagues = { betLeague?: string | null; fixtureLeague?: string | null };

function orientedSideScore(
  betCanon: string,
  fixtureCanon: string,
  leagues: CategoryLeagues,
): TeamSideSimilarity & { compatible: boolean } {
  const category = areCategoriesCompatible({ betCanon, fixtureCanon, ...leagues });
  return {
    ...teamSideSimilarityCanon(
      stripCategoryTokens(betCanon, category.coveredTokens),
      stripCategoryTokens(fixtureCanon, category.coveredTokens),
    ),
    compatible: category.compatible,
  };
}

/** Nenhum nome nem competição declara categoria: a comparação é a de nomes. */
function declaresNoCategory(canons: readonly string[], leagues: CategoryLeagues): boolean {
  return canons.every((canon) => teamCategoryTokens(canon).size === 0)
    && categoryTokensFromLeague(leagues.betLeague ?? "").size === 0
    && categoryTokensFromLeague(leagues.fixtureLeague ?? "").size === 0;
}

/**
 * Similaridade dos dois lados de um confronto nas duas orientações, com a
 * categoria lida também nas competições: a categoria que os dois lados
 * declaram sai da comparação de nomes, e orientação incompatível vale 0.
 */
export function matchTeamsWithCategoryContext(params: {
  betHome: string;
  betAway: string;
  fixtureHome: string;
  fixtureAway: string;
  betLeague?: string | null;
  fixtureLeague?: string | null;
}): MatchTeamsResult {
  return matchCanonTeamsWithCategoryContext({
    ...params,
    betHome: canonicalizeTeamName(params.betHome),
    betAway: canonicalizeTeamName(params.betAway),
    fixtureHome: canonicalizeTeamName(params.fixtureHome),
    fixtureAway: canonicalizeTeamName(params.fixtureAway),
  });
}

/**
 * Núcleo de `matchTeamsWithCategoryContext` para quem JÁ tem os nomes
 * canonicalizados: o laço contra o catálogo do dia canonicaliza a aposta uma
 * vez. Sem categoria declarada em lugar nenhum, que é o caso comum, pula a
 * leitura de categoria por orientação.
 */
export function matchCanonTeamsWithCategoryContext(params: {
  betHome: string;
  betAway: string;
  fixtureHome: string;
  fixtureAway: string;
  betLeague?: string | null;
  fixtureLeague?: string | null;
}): MatchTeamsResult {
  const leagues = { betLeague: params.betLeague, fixtureLeague: params.fixtureLeague };
  const { betHome, betAway, fixtureHome, fixtureAway } = params;
  const side = declaresNoCategory([betHome, betAway, fixtureHome, fixtureAway], leagues)
    ? (bet: string, fixture: string) => ({ ...teamSideSimilarityCanon(bet, fixture), compatible: true })
    : (bet: string, fixture: string) => orientedSideScore(bet, fixture, leagues);

  const dHome = side(betHome, fixtureHome);
  const dAway = side(betAway, fixtureAway);
  const directCompatible = dHome.compatible && dAway.compatible;
  const direct = directCompatible ? dHome.score + dAway.score : 0;

  const iHome = side(betAway, fixtureHome);
  const iAway = side(betHome, fixtureAway);
  const invertedCompatible = iHome.compatible && iAway.compatible;
  const inverted = invertedCompatible ? iHome.score + iAway.score : 0;

  const swapped = inverted > direct;
  const [chosenHome, chosenAway] = swapped ? [iHome, iAway] : [dHome, dAway];
  return {
    directHome: dHome.score,
    directAway: dAway.score,
    invertedHome: iHome.score,
    invertedAway: iAway.score,
    direct,
    inverted,
    swapped,
    score: Math.max(direct, inverted),
    compatible: swapped ? invertedCompatible : directCompatible,
    anchored: fixtureHasAnchorSide(chosenHome.evidence, chosenAway.evidence),
    evidenceHome: chosenHome.evidence,
    evidenceAway: chosenAway.evidence,
  };
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

/** O mesmo confronto com o principal e a categoria no mesmo fim de semana. */
const CATEGORY_TWIN_WINDOW_MS = 36 * 3_600_000;
/** O mesmo jogo listado duas vezes pelo provider ("Sarpsborg 08" e "Sarpsborg"). */
const DUPLICATE_LISTING_WINDOW_MS = 10 * 60_000;
const DUPLICATE_LISTING_MIN_SIDE = 0.85;

function pairWithoutCategory(fixture: CategoryCandidateFixture): string {
  const side = (name: string) => {
    const canon = canonicalizeTeamName(name);
    return stripCategoryTokens(canon, teamCategoryTokens(canon));
  };
  return [side(fixture.home), side(fixture.away)].sort().join(" x ");
}

function canonicalCountryKey(country?: string | null): string {
  return normalizeStr(country ?? "").trim();
}

function declaresCategory(home: string, away: string, league?: string | null): boolean {
  return teamCategoryInContext(home, league).size > 0 || teamCategoryInContext(away, league).size > 0;
}

/**
 * O mesmo jogo listado duas vezes: mesmo país, mesmo horário e os dois times
 * parecidos. Homônimos de países diferentes no mesmo horário ("Agua Santa vs
 * Palmeiras" no Brasil e no Chile) continuam jogos diferentes, e o empate entre
 * eles segue sem decisão.
 */
function sameListedGame(a: CategoryCandidateFixture, b: CategoryCandidateFixture): boolean {
  if (Math.abs(a.kickoffMs - b.kickoffMs) > DUPLICATE_LISTING_WINDOW_MS) return false;
  const countryA = canonicalCountryKey(a.country), countryB = canonicalCountryKey(b.country);
  if (!countryA || countryA !== countryB) return false;
  // Mando trocado no mesmo horário é outro jogo: a pré-temporada da NHL tem
  // Montreal x Toronto e Toronto x Montreal às 23:00, com ids diferentes.
  const [ah, aa, bh, ba] = [a.home, a.away, b.home, b.away].map(canonicalizeTeamName);
  return Math.min(teamSimilarityCanon(ah!, bh!), teamSimilarityCanon(aa!, ba!)) >= DUPLICATE_LISTING_MIN_SIDE;
}

/**
 * Depois da nota dos nomes, o que a categoria decide entre os candidatos:
 * 1. jogo de base nunca é candidato (`isBaseCategoryFixture`);
 * 2. sem categoria declarada no post (nome ou campeonato), o jogo principal
 *    vence o gêmeo de reserva ou feminino com os mesmos times, desde que não
 *    esteja com o mando pior que o dele nem mais longe do horário do post; o de
 *    categoria fica quando o par não existe no principal (Arsenal x HB Køge);
 * 3. o mesmo jogo listado duas vezes, até com o mando trocado, conta uma vez
 *    — só no provider sem id de time (Pinnacle, BridgeOdds): no FlashScore, dois
 *    jogos com os mesmos nomes e ids diferentes são jogos diferentes.
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
  const withoutBase = params.candidates.filter((c) => !isBaseCategoryFixture(params.fixture(c)));
  const betDeclares = declaresCategory(params.betHome, params.betAway, params.betLeague);
  const principals = withoutBase.map(params.fixture).filter((f) => !declaresCategory(f.home, f.away, f.league));
  const withoutTwins = betDeclares ? withoutBase : withoutBase.filter((candidate) => {
    const fixture = params.fixture(candidate);
    if (!declaresCategory(fixture.home, fixture.away, fixture.league)) return true;
    const pair = pairWithoutCategory(fixture);
    const betAt = params.betKickoffMs;
    return !principals.some((p) =>
      pairWithoutCategory(p) === pair && Math.abs(p.kickoffMs - fixture.kickoffMs) <= CATEGORY_TWIN_WINDOW_MS
      && (!p.swapped || fixture.swapped)
      && (betAt == null || Math.abs(p.kickoffMs - betAt) <= Math.abs(fixture.kickoffMs - betAt)));
  });
  if (!params.collapseDuplicateListings) return withoutTwins;
  const kept: T[] = [];
  for (const candidate of withoutTwins) {
    const fixture = params.fixture(candidate);
    if (kept.some((k) => sameListedGame(params.fixture(k), fixture))) continue;
    kept.push(candidate);
  }
  return kept;
}

const SOCCER_RESERVE_MARKER = /\s+(?:R|Res)\.?\s*$/i;

/**
 * O "R"/"Res" de reserva do tipster do futebol argentino nos DOIS times
 * ("Talleres R vs Gimnasia Mendoza R") vira "Reserva", que a categoria já
 * entende; a Pinnacle escreve só "Talleres de Cordoba" e põe a categoria na
 * liga. Nos dois times, porque um só ("Bristol R" é o Rovers) não diz
 * reserva. Quem chama garante o futebol: no tênis a letra no fim é a inicial
 * do jogador ("Nadal R"). A seleção troca o nome inteiro de cada time, o mais
 * longo primeiro: "Estudiantes R" não pode cair dentro de "Estudiantes Rio
 * Cuarto R".
 */
export function markSoccerReserveTeams(bet: { evento: string; selecao: string }): { evento: string; selecao: string } {
  const teams = splitEventoTeams(bet.evento);
  if (!teams || !SOCCER_RESERVE_MARKER.test(teams.home) || !SOCCER_RESERVE_MARKER.test(teams.away)) return bet;
  const marked = new Map([teams.home, teams.away].map((name) => [name, name.replace(SOCCER_RESERVE_MARKER, " Reserva")]));
  const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = [...marked.keys()].sort((a, b) => b.length - a.length).map(escape).join("|");
  const whole = new RegExp(`(?<![\\p{L}\\p{N}])(${names})(?![\\p{L}\\p{N}])`, "gu");
  return {
    evento: `${marked.get(teams.home)} vs ${marked.get(teams.away)}`,
    selecao: bet.selecao.replace(whole, (name) => marked.get(name) ?? name),
  };
}

