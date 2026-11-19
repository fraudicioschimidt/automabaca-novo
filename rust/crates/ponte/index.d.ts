// Tipos das funções da ponte: as mesmas nos dois lados (`src/node.rs` e
// `src/wasm.rs`), conferidas por `tests/plataforma/ponte.test.ts`. Função nova
// entra nos dois lados e aqui, com o nome em camelCase.
//
// `export =`, e não exports nomeados: o carregador do servidor é CommonJS com
// o binário num `require`, e o ESM do Node só enxerga o default dele. Importe
// sempre `import dominio from "@automabaca/dominio"`
// (`tests/plataforma/architecture-boundaries.test.ts` recusa o resto).
type DoubleChanceOutcome = "home" | "away" | "draw";
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
  /** O time limpo, ou `null` quando a seleção não é DNB / Dupla Chance. */
  stripDrawNoBetFromSelection(selecao: string): string | null;
  stripDoubleChanceFromSelection(selecao: string): string | null;
  /** Cada termo: os trechos que precisam estar todos no mercado. */
  drawNoBetSqlTerms(): string[][];
  doubleChanceSqlTerms(): string[][];
  /** Ver `src/domain/mercados/stat-qualifier.ts`. */
  nonScoreStatTerms(): string;
  /** `[terms, sports]` de gols, corridas e pontos, nessa ordem. */
  scoreUnitRules(): [
    goals: [terms: string[], sports: string[]],
    runs: [terms: string[], sports: string[]],
    points: [terms: string[], sports: string[]],
  ];
  isBothTeamsCardsText(text: string): boolean;
  selecaoDeclaraLinhaDeEstatistica(selecao: string): boolean;
  hasNonScoreStatQualifier(mercado: string, selecao: string): boolean;
  hasUnknownScoreQualifier(mercado: string): boolean;
  knownScoreQualifierSqlTerms(): string[];
  nonScoreStatSqlTerms(): string[];
  scoreUnitTermsForSql(): string[];
  hasScoreUnitMismatch(mercado: string, selecao: string, esporte?: string): boolean;
  hasSportScoreUnitMismatch(mercado: string, selecao: string, esporte?: string): boolean;
  /** Ver `src/domain/mercados/classify.ts`. */
  classifyData(): [
    patterns: [extraTime: string, regulationTime: string],
    lists: [
      outrightScopeNouns: string[], outrightWinnerPhrases: string[],
      halfFirst: string[], halfSecond: string[], abbreviationsFirst: string[], abbreviationsSecond: string[],
    ],
  ];
  isEsports(esporte?: string | null): boolean;
  marketMapNumberOf(mercado: string, esporte?: string | null): number | null;
  marketIncludesExtraTime(mercado: string): boolean;
  declaresRegulationTime(text: string): boolean;
  isBttsMarket(mercado: string): boolean;
  isCombinedBttsMarket(mercado: string): boolean;
  bttsSelectionSide(selecao: string): "yes" | "no" | null;
  isRaceToMarket(mercado: string, selecao: string): boolean;
  isThreeWayHandicapMarket(mercado: string): boolean;
  isOutrightMarket(mercado: string): boolean;
  isMethodOfVictoryMarket(mercado: string): boolean;
  isDrawNoBetMarket(mercado: string): boolean;
  isDoubleChanceMarket(mercado: string): boolean;
  totalLabelSide(mercado: string, evento: string): "home" | "away" | null;
  marketPeriodOf(mercado: string, esporte?: string | null): "FT" | "HT" | "SECOND_HALF" | "MAP" | "OTHER";
  marketKindOf(
    mercado: string,
    selecao: string,
    evento?: string,
  ):
    | "moneyline" | "total" | "spread" | "team_total" | "draw_no_bet" | "double_chance"
    | "btts" | "correct_score" | "scorer" | "player_props" | "other";
  /** Ver `src/domain/mercados/compatibility.ts` e `finalize.ts`. */
  compatibilityData(): [
    finalMarketSports: [market: string, sports: string[]][],
    regulationTimeMarkets: [moneyline: string, spread: string, total: string],
    regulationTimeSports: string[],
  ];
  marketSportOf(esporte?: string | null): string;
  restrictsToRegulationTime(text: string, esporte?: string | null): boolean;
  regulationTimeBaseOf(mercado: string): string | null;
  isRegulationTimeMarket(mercado: string): boolean;
  isMercadoFinalForSport(mercado: string, esporte?: string | null): boolean;
  finalizePinnacleMarket(mercado: string, esporte?: string): string;
  regulationTimeMarket(mercado: string, selecao: string, evento: string, esporte: string | undefined, declared: boolean): string;
  pinnacleizeMercado(mercado: string, esporte?: string): string;
  keepDeclaredPeriod(original: string, coerced: string, esporte: string | undefined, selecao: string): string;
  /** Ver `src/domain/mercados/double-chance-selection.ts` e `sharp-equivalent.ts`. */
  canonicalDoubleChanceSelection(evento: string, mercado: string, selecao: string, esporte: string): [mercado: string, selecao: string] | null;
  supportsSharpEquivalence(esporte?: string): boolean;
  sharpEquivalentBet(
    mercado: string,
    selecao: string,
    evento: string,
    esporte?: string,
  ): [mercado: string, selecao: string, nota: "dnb→ah_0.0" | "dc→ah_+0.5"] | null;
  /** Ver `src/domain/settlement/lines.ts`. */
  unknownLineSeparator(): string;
  lineToQuarters(line: number): number | null;
  withoutNumberedHalf(text: string): string;
  extractSignedNumbers(text: string): number[];
  parseLineQuarters(selecao: string, allowNegative: boolean): number | null;
  statusFromAdjustedQuarters(adjusted: number): "VOID" | "HALF_WON" | "HALF_LOST" | "WON" | "LOST";
  /** Ver `src/domain/bookmaker.ts`. */
  canonicalizeBookmakerName(value: string): string;
  /** Ver `src/domain/settlement/goalscorer-matching.ts`. */
  goalscorerThresholds(): [similaridade: number, vantagem: number];
  tokensDoNome(nome: string): string[];
  similaridadeDeTokens(ta: string[], tb: string[]): number;
  tokensDaSelecao(selecao: string): string[];
  temPolaridadeNegativa(textos: string[]): boolean;
  playerMatchRefusals(): Array<"selecao_sem_jogador" | "sem_jogadores" | "jogador_nao_encontrado" | "jogador_ambiguo">;
  encontrarJogadorNaPartida(selecao: string, nomes: string[], nomesCurtos: string[]): number[];
  participationUnproven(minutosPublicados: boolean, participou: boolean, semGols: boolean): boolean;
  listedButDidNotPlay(minutos: number | null, participou: boolean, semGols: boolean): boolean;
  /** Ver `src/domain/settlement/over-under-subject.ts`. */
  prefixoAntesDaLinha(selecao: string): string | null;
  subjectAfterLine(selecao: string, evento?: string): string | null;
  lineSubjectIsNotEventTeam(selecao: string, evento?: string): boolean;
  /** Ver `src/domain/mercados/selection-shape.ts`. */
  stripSelectionOdds(selection: string): string;
  isEsportsPlayerSelection(selecao: string, evento: string): boolean;
  selectionTotalLine(selecao: string, evento: string): number | null;
  selecaoPareceHandicap(selecao: string): boolean;
  selecaoNomeiaTimeDoTotal(selecao: string, evento: string): boolean;
  declaresEuropeanHandicap(selecao: string): boolean;
  /** Ver `src/domain/settlement/markets.ts`. */
  classifyScoreMarket(
    mercadoN: string,
    selecaoN: string,
    evento?: string,
  ): "handicap" | "total" | "team_total" | "btts" | "moneyline" | "draw_no_bet" | "double_chance" | null;
  isScoreResolvableMarket(mercado: string, selecao: string, esporte?: string, evento?: string): boolean;
  declaredScorePeriod(mercado: string, selecao: string, esporte?: string): "FT" | "HT" | "SECOND_HALF" | "MAP" | "OTHER";
  /** Ver `src/domain/settlement/goalscorer.ts`. */
  ehMercadoArtilheiro(mercado: string, selecao?: string): boolean;
  ehMercadoArtilheiroPorTempo(mercado: string, selecao?: string): boolean;
  hasUnsupportedGoalQualifier(mercado: string, selecao: string): boolean;
  orderedGoalscorerMarketOrder(mercado: string, selecao?: string): "first" | "last" | null;
  minutoBase(raw: string): number | null;
  requiredPlayerGoals(mercado: string, selecao: string): number | null;
  /** Ver `src/domain/settlement/sides.ts`. */
  stripTeamNames(selecao: string, evento: string): string;
  matchTeamSide(selecao: string, evento: string): "home" | "away" | null;
  matchMoneylineSelection(selecao: string, evento: string, strict: boolean): "home" | "away" | "draw" | null;
  resolveSideFromMarketAndSelection(
    mercado: string,
    selecao: string,
    evento: string,
  ): [side: "home" | "away" | null, contradicts: boolean];
  matchDrawNoBetSelection(selecao: string, evento: string): "home" | "away" | null;
  matchDoubleChanceSelection(
    selecao: string,
    evento: string,
  ): [DoubleChanceOutcome, DoubleChanceOutcome] | null;
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
  /** Ver `src/domain/countries.ts` e `national-teams.ts`. As tabelas que o TS lê, na ordem dos objetos. */
  countryTables(): [
    nationalTeams: Array<[pt: string, en: string]>,
    countries: Array<[name: string, country: string]>,
    knownCountryKeys: string[],
  ];
  translateNationalTeamPtToEn(localName: string): string | null;
  canonicalCountry(raw: string): string;
  canonicalCompetition(raw: string, pais: string | null | undefined): string;
  rewriteNationalTeamsInText(text: string, eventTeams: readonly string[] | null | undefined): string;
  rewriteSelecaoWithMatchedTeams(
    selecao: string, localHome: string, localAway: string, pinnacleHome: string, pinnacleAway: string,
  ): string;
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
