// Tipos das funções da ponte: as mesmas nos dois lados (`src/node.rs` e
// `src/wasm.rs`), conferidas por `tests/plataforma/ponte.test.ts`. Função nova
// entra nos dois lados e aqui, com o nome em camelCase.
//
// `export =`, e não exports nomeados: o carregador do servidor é CommonJS com
// o binário num `require`, e o ESM do Node só enxerga o default dele. Importe
// sempre `import dominio from "@automabaca/dominio"`
// (`tests/plataforma/architecture-boundaries.test.ts` recusa o resto).
/** `[sport, status, confidence, source, fontes, esportes, confianças, valores]` das evidências. */
type SportDecisionColumns = [
  sport: string | null, status: string, confidence: number, source: string,
  evidenceSources: string[], evidenceSports: string[], evidenceConfidences: number[], evidenceValues: string[],
];
declare const dominio: {
  /** Versão do crate, a de `rust/Cargo.toml`. */
  versao(): string;
  /** Ver `src/domain/cron-cadence.ts`. */
  cronMaxGapMinutes(cron: string): number;
  cronFiringMinutes(cron: string): number[];
  /** Instantes em milissegundos da época; `null` quando o intervalo não tem disparo. */
  latestCronFiring(cron: string, afterMs: number, untilMs: number, utcOffsetHours: number): number | null;
  /** Ver `src/domain/kelly.ts`: `[implícita, estimada, fração]`, ou `null`. */
  analyzeKelly(odds: number, vantagemPct: number): [number, number, number] | null;
  kellyStake(odds: number, vantagemPct: number, fraction: number, capUnits: number): number;
  /** Ver `src/domain/decimal-input.ts`: só o texto; `null` quando não dá para ler sem adivinhar. */
  parseDecimalText(value: string): number | null;
  parseMoneyText(value: string): number | null;
  /** Ver `src/domain/odds.ts`. */
  powerFairProbs(odds: readonly number[]): number[] | null;
  shinFairProbs(odds: readonly number[]): number[] | null;
  powerFairOdds(odds: readonly number[]): number[] | null;
  shinFairOdds(odds: readonly number[]): number[] | null;
  autoFairOdds(odds: readonly number[]): number[] | null;
  autoFairProbs(odds: readonly number[]): number[] | null;
  combineQuarterLineOdds(side: string, aLineQ: number, aOdd: number, bLineQ: number, bOdd: number): number | null;
  percentualContraFair(bookOdd: number, fairOdd: number): number | null;
  /** Ver `src/domain/dates.ts`: instantes em milissegundos desde a época. */
  spDayKey(ms: number): string;
  formatSpTime(ms: number): string;
  formatSpDayMonth(ms: number): string;
  formatSpDateTime(ms: number): string;
  formatSpDateWithYear(ms: number): string;
  spGreeting(ms: number): string;
  formatSpFullDate(ms: number): string;
  spStartOfTodayUtc(nowMs: number): number;
  spWeekKey(ms: number): string;
  spRelative(dateMs: number, nowMs: number): string;
  spToUtc(year: number, month: number, day: number, hour: number, minute: number): number;
  formatDurationMinutes(minutes: number | null): string;
  shiftDayKey(dayKey: string, days: number): string;
  parseSpDateTimeInput(dateText: string, timeText: string): number | null;
  /** Ver `src/domain/money.ts`. */
  sumMoneyDecimal(values: readonly number[], decimals: number): number;
  sumMoneyBy(values: readonly number[], decimals: number): number;
  roundMoney(value: number, decimals: number): number;
  multiplyMoneyDecimal(
    value: number, multiplier: number, decimals: number, multiplierDecimals: number,
    divisor: number, divisorDecimals: number, resultDecimals: number,
  ): number;
  moneyByPercent(value: number, percent: number): number;
  unitsToBrl(units: number, valorUnidade: number): number;
  unitsToReais(units: number, unitValue: number): number;
  kahanSum(values: readonly number[]): number;
  /** Inteiros em texto decimal: o BigInt atravessa como `toString()`. */
  divideRoundHalfAway(value: string, divisor: string): string;
  MoneyAccumulator: new (decimals: number) => { add(value: number): number; readonly value: number };
  /** `[instante, só a data]`; ver `parseBrKickoffDetailed` em `src/domain/dates-parsing.ts`. */
  parseBrKickoff(text: string, refMs: number): [ms: number, dateOnly: boolean] | null;
  /** Ver `src/domain/text-normalization.ts`. */
  normalizeStr(text: string): string;
  canonicalizeTeamName(text: string): string;
  isProtectedToken(token: string): boolean;
  teamNameVariants(canon: string): string[];
  teamStopWords(): string[];
  teamNameEquivalents(): string[][];
  /** Ver `src/domain/team-category.ts`. Ligas nulas valem como ausentes. */
  teamCategoryTokens(canon: string, digitsOnly: boolean): string[];
  reserveSuffixMismatch(ca: string, cb: string): boolean;
  hasProtectedTeamCategoryConflict(a: string, b: string): boolean;
  teamIdentityCategoryConflict(a: string, b: string): boolean;
  betDeclaresCategoryFixtureLacks(canonAposta: string, canonFixture: string): boolean;
  categoryTokensFromLeague(league: string): string[];
  leagueCoversBetCategory(canonAposta: string, canonFixture: string, league: string | null | undefined): boolean;
  orientedTeamPairHasReserveSuffixConflict(
    providerHome: string, providerAway: string, localHome: string, localAway: string,
    swapped: boolean, league: string | null | undefined,
  ): boolean;
  stripCategoryTokens(canonName: string, tokens: string[]): string;
  areCategoriesCompatible(
    betCanon: string, fixtureCanon: string, betLeague: string | null | undefined, fixtureLeague: string | null | undefined,
  ): [compatible: boolean, coveredTokens: string[]];
  teamCategoryConflictInContext(
    betName: string, fixtureName: string, betLeague: string | null | undefined, fixtureLeague: string | null | undefined,
  ): boolean;
  teamCategoryInContext(name: string, league: string | null | undefined): string[];
  sameTeamCategory(a: string[], b: string[]): boolean;
  isBaseCategoryFixture(home: string, away: string, league: string | null | undefined): boolean;
  /** Ver `src/domain/text.ts`. */
  teamSimilarity(a: string, b: string): number;
  teamSimilarityCanon(ca: string, cb: string): number;
  teamSideSimilarityCanon(ca: string, cb: string): [score: number, evidence: number];
  teamNameEvidence(a: string, b: string): number;
  fixtureHasAnchorSide(homeEvidence: number, awayEvidence: number): boolean;
  anchorSideFloor(): number;
  bestSearchWord(text: string): string;
  splitEventoTeams(evento: string): [home: string, away: string] | null;
  fixtureHasPlaceholderTeam(evento: string): boolean;
  sameFixtureTeams(eventoA: string, eventoB: string): boolean;
  slugify(text: string): string;
  /** Os 12 campos de `MatchTeamsResult`, na ordem do tipo (booleanos como 0/1). */
  matchTeamsWithCategoryContext(
    betHome: string, betAway: string, fixtureHome: string, fixtureAway: string,
    betLeague: string | null | undefined, fixtureLeague: string | null | undefined, canonical: boolean,
  ): number[];
  /** Os candidatos em colunas (liga e país vazios = ausentes); devolve os índices que ficam. */
  refineCategoryCandidates(
    betHome: string, betAway: string, betLeague: string | null | undefined, betKickoffMs: number | null | undefined,
    collapseDuplicateListings: boolean, homes: string[], aways: string[], leagues: string[], countries: string[],
    kickoffs: number[], swapped: number[],
  ): number[];
  markSoccerReserveTeams(evento: string, selecao: string): [evento: string, selecao: string] | null;
  /** Ver `src/domain/mercados/`. */
  accentuate(term: string): string;
  accentVariants(term: string): string[];
  /** `[MATCH_SCOPE_NOUNS, SIDE_SCOPE_NOUNS]`. */
  scopeNouns(): [string[], string[]];
  trailingTeamCandidate(trailing: string): string | null;
  trailingTeamCandidateOfSelection(selecao: string): string | null;
  separateCompactStatUnit(text: string): string;
  expandAbbreviatedDirection(selection: string): string;
  totalDirectionOf(selection: string, allowBarePositiveLine: boolean): "over" | "under" | null;
  /** `[OVER_WORDS, UNDER_WORDS]`. */
  totalDirectionWords(): [over: string, under: string];
  mercadosIntermediarios(): string[];
  /** As traduções diretas PT/legado, na ordem do catálogo. */
  mercadoTranslations(): Array<[from: string, to: string]>;
  normalizeMercadoKey(text: string): string;
  resolveMercadoCanonical(raw: string): string | null;
  resolveMercadoStatic(raw: string): string | null;
  isMercadoFinal(mercado: string): boolean;
  /** As 8 listas de DRAW_NO_BET_VOCABULARY e as 3 de DOUBLE_CHANCE_VOCABULARY, na ordem dos campos. */
  drawVocabulary(): [
    standalone: string[], abbreviations: string[], verbs: string[], objects: string[], states: string[],
    nouns: string[], nounQualifiers: string[], connectors: string[],
    doubleChanceStandalone: string[], doubleChanceAbbreviations: string[], doubleChanceTerms: string[],
  ];
  drawNoBetPattern(space: string): string;
  doubleChancePattern(space: string): string;
  /** O time limpo, ou `null` quando a seleção não é DNB / Dupla Chance. */
  stripDrawNoBetFromSelection(selecao: string): string | null;
  stripDoubleChanceFromSelection(selecao: string): string | null;
  /** Cada termo: os trechos que precisam estar todos no mercado. */
  drawNoBetSqlTerms(): string[][];
  doubleChanceSqlTerms(): string[][];
  /** Ver `src/domain/sports/`. */
  canonicalSport(value: string | null | undefined): string | null;
  esportesComUnidade(unidade: string): string[];
  termosDeUnidadeSemPlacar(): string[];
  sportDetectionConstants(): [resolverVersion: number, autoConfirm: number, dissent: number, sharedSoccerLeague: string];
  /** A decisão: o cabeçalho e as evidências em colunas. */
  detectSportFromText(text: string, itemSport: string | null | undefined): SportDecisionColumns;
  llmSportDecision(
    sport: string | null | undefined, confidence: number | null | undefined, evidenceText: string | null | undefined,
  ): SportDecisionColumns;
  /**
   * O regex do domínio cru, só para `tests/plataforma/js-regex.test.ts`
   * comparar os dois lados com o V8. `regexExec` devolve `[início, fim]` UTF-16
   * de cada grupo (-1 no que não participou), como `exec` com `lastIndex`.
   */
  regexCatalog(): Array<[source: string, flags: string]>;
  regexExec(source: string, flags: string, text: string, from: number): number[] | null;
  regexReplace(source: string, flags: string, text: string, replacement: string): string;
  regexSplit(source: string, flags: string, text: string, limit?: number): string[];
};
export = dominio;
