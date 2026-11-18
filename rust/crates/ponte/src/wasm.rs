//! Lado WebAssembly da ponte (navegador, `browser.mjs`). O `wasm-bindgen`
//! devolveria `undefined` para `Option` e um array tipado para `Vec`: aqui
//! saem `null` e `Array`, como na N-API.

use dominio::cron;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn versao() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

fn js_error(error: cron::CronError) -> JsError {
    JsError::new(&error.to_string())
}

#[wasm_bindgen(js_name = cronMaxGapMinutes)]
pub fn cron_max_gap_minutes(cron: &str) -> Result<u32, JsError> {
    cron::cron_max_gap_minutes(cron).map_err(js_error)
}

#[wasm_bindgen(js_name = cronFiringMinutes)]
pub fn cron_firing_minutes(cron: &str) -> Result<Vec<JsValue>, JsError> {
    cron::cron_firing_minutes(cron)
        .map(|minutes| minutes.into_iter().map(JsValue::from).collect())
        .map_err(js_error)
}

#[wasm_bindgen(js_name = latestCronFiring)]
pub fn latest_cron_firing(
    cron: &str,
    after_ms: f64,
    until_ms: f64,
    utc_offset_hours: f64,
) -> Result<JsValue, JsError> {
    cron::latest_cron_firing(cron, after_ms, until_ms, utc_offset_hours)
        .map(|firing| firing.map_or(JsValue::NULL, JsValue::from))
        .map_err(js_error)
}

#[wasm_bindgen(js_name = analyzeKelly)]
pub fn analyze_kelly(odds: f64, vantagem_pct: f64) -> JsValue {
    dominio::kelly::analyze_kelly(odds, vantagem_pct).map_or(JsValue::NULL, |analysis| {
        let valores: Vec<JsValue> = [
            analysis.implied_probability,
            analysis.estimated_probability,
            analysis.full_fraction,
        ]
        .into_iter()
        .map(JsValue::from)
        .collect();
        JsValue::from(valores)
    })
}

#[wasm_bindgen(js_name = kellyStake)]
pub fn kelly_stake(odds: f64, vantagem_pct: f64, fraction: f64, cap_units: f64) -> f64 {
    dominio::kelly::kelly_stake(odds, vantagem_pct, fraction, cap_units)
}

fn number_or_null(value: Option<f64>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

#[wasm_bindgen(js_name = parseDecimalText)]
pub fn parse_decimal_text(value: &str) -> JsValue {
    number_or_null(dominio::decimal_input::parse_decimal_text(value))
}

#[wasm_bindgen(js_name = parseMoneyText)]
pub fn parse_money_text(value: &str) -> JsValue {
    number_or_null(dominio::decimal_input::parse_money_text(value))
}

fn numbers_or_null(values: Option<Vec<f64>>) -> JsValue {
    values.map_or(JsValue::NULL, |values| {
        JsValue::from(
            values
                .into_iter()
                .map(JsValue::from)
                .collect::<Vec<JsValue>>(),
        )
    })
}

#[wasm_bindgen(js_name = powerFairProbs)]
pub fn power_fair_probs(odds: &[f64]) -> JsValue {
    numbers_or_null(dominio::odds::power_fair_probs(odds))
}

#[wasm_bindgen(js_name = shinFairProbs)]
pub fn shin_fair_probs(odds: &[f64]) -> JsValue {
    numbers_or_null(dominio::odds::shin_fair_probs(odds))
}

#[wasm_bindgen(js_name = powerFairOdds)]
pub fn power_fair_odds(odds: &[f64]) -> JsValue {
    numbers_or_null(dominio::odds::power_fair_odds(odds))
}

#[wasm_bindgen(js_name = shinFairOdds)]
pub fn shin_fair_odds(odds: &[f64]) -> JsValue {
    numbers_or_null(dominio::odds::shin_fair_odds(odds))
}

#[wasm_bindgen(js_name = autoFairOdds)]
pub fn auto_fair_odds(odds: &[f64]) -> JsValue {
    numbers_or_null(dominio::odds::auto_fair_odds(odds))
}

#[wasm_bindgen(js_name = autoFairProbs)]
pub fn auto_fair_probs(odds: &[f64]) -> JsValue {
    numbers_or_null(dominio::odds::auto_fair_probs(odds))
}

#[wasm_bindgen(js_name = combineQuarterLineOdds)]
pub fn combine_quarter_line_odds(
    side: &str,
    a_line_q: f64,
    a_odd: f64,
    b_line_q: f64,
    b_odd: f64,
) -> JsValue {
    use dominio::odds::QuarterLineComponent;
    number_or_null(dominio::odds::combine_quarter_line_odds(
        side,
        QuarterLineComponent {
            line_q: a_line_q,
            odd: a_odd,
        },
        QuarterLineComponent {
            line_q: b_line_q,
            odd: b_odd,
        },
    ))
}

#[wasm_bindgen(js_name = percentualContraFair)]
pub fn percentual_contra_fair(book_odd: f64, fair_odd: f64) -> JsValue {
    number_or_null(dominio::odds::percentual_contra_fair(book_odd, fair_odd))
}

fn date_error(error: dominio::dates::DateError) -> JsError {
    JsError::new(&error.0)
}

#[wasm_bindgen(js_name = spDayKey)]
pub fn sp_day_key(ms: f64) -> Result<String, JsError> {
    dominio::dates::sp_day_key(ms).map_err(date_error)
}

#[wasm_bindgen(js_name = formatSpTime)]
pub fn format_sp_time(ms: f64) -> String {
    dominio::dates::format_sp_time(ms)
}

#[wasm_bindgen(js_name = formatSpDayMonth)]
pub fn format_sp_day_month(ms: f64) -> String {
    dominio::dates::format_sp_day_month(ms)
}

#[wasm_bindgen(js_name = formatSpDateTime)]
pub fn format_sp_date_time(ms: f64) -> String {
    dominio::dates::format_sp_date_time(ms)
}

#[wasm_bindgen(js_name = formatSpDateWithYear)]
pub fn format_sp_date_with_year(ms: f64) -> String {
    dominio::dates::format_sp_date_with_year(ms)
}

#[wasm_bindgen(js_name = spGreeting)]
pub fn sp_greeting(ms: f64) -> String {
    dominio::dates::sp_greeting(ms).to_owned()
}

#[wasm_bindgen(js_name = formatSpFullDate)]
pub fn format_sp_full_date(ms: f64) -> String {
    dominio::dates::format_sp_full_date(ms)
}

#[wasm_bindgen(js_name = spStartOfTodayUtc)]
pub fn sp_start_of_today_utc(now_ms: f64) -> f64 {
    dominio::dates::sp_start_of_today_utc(now_ms)
}

#[wasm_bindgen(js_name = spWeekKey)]
pub fn sp_week_key(ms: f64) -> String {
    dominio::dates::sp_week_key(ms)
}

#[wasm_bindgen(js_name = spRelative)]
pub fn sp_relative(date_ms: f64, now_ms: f64) -> String {
    dominio::dates::sp_relative(date_ms, now_ms)
}

#[wasm_bindgen(js_name = spToUtc)]
pub fn sp_to_utc(year: f64, month: f64, day: f64, hour: f64, minute: f64) -> f64 {
    dominio::dates::sp_to_utc(year, month, day, hour, minute)
}

#[wasm_bindgen(js_name = formatDurationMinutes)]
pub fn format_duration_minutes(minutes: Option<f64>) -> String {
    dominio::dates::format_duration_minutes(minutes)
}

#[wasm_bindgen(js_name = shiftDayKey)]
pub fn shift_day_key(day_key: &str, days: f64) -> Result<String, JsError> {
    dominio::dates::shift_day_key(day_key, days).map_err(date_error)
}

#[wasm_bindgen(js_name = parseSpDateTimeInput)]
pub fn parse_sp_date_time_input(date_text: &str, time_text: &str) -> JsValue {
    number_or_null(dominio::dates::parse_sp_date_time_input(
        date_text, time_text,
    ))
}

fn money_error(error: dominio::money::MoneyError) -> JsError {
    JsError::new(&error.0)
}

#[wasm_bindgen(js_name = sumMoneyDecimal)]
pub fn sum_money_decimal(values: &[f64], decimals: f64) -> Result<f64, JsError> {
    dominio::money::sum_money_decimal(values, decimals).map_err(money_error)
}

#[wasm_bindgen(js_name = sumMoneyBy)]
pub fn sum_money_by(values: &[f64], decimals: f64) -> Result<f64, JsError> {
    dominio::money::sum_money_by(values, decimals).map_err(money_error)
}

#[wasm_bindgen(js_name = roundMoney)]
pub fn round_money(value: f64, decimals: f64) -> Result<f64, JsError> {
    dominio::money::round_money(value, decimals).map_err(money_error)
}

#[wasm_bindgen(js_name = multiplyMoneyDecimal)]
pub fn multiply_money_decimal(
    value: f64,
    multiplier: f64,
    decimals: f64,
    multiplier_decimals: f64,
    divisor: f64,
    divisor_decimals: f64,
    result_decimals: f64,
) -> Result<f64, JsError> {
    let options = dominio::money::MultiplyOptions {
        decimals,
        multiplier_decimals,
        divisor,
        divisor_decimals,
        result_decimals,
    };
    dominio::money::multiply_money_decimal(value, multiplier, options).map_err(money_error)
}

#[wasm_bindgen(js_name = moneyByPercent)]
pub fn money_by_percent(value: f64, percent: f64) -> Result<f64, JsError> {
    dominio::money::money_by_percent(value, percent).map_err(money_error)
}

#[wasm_bindgen(js_name = unitsToBrl)]
pub fn units_to_brl(units: f64, valor_unidade: f64) -> Result<f64, JsError> {
    dominio::money::units_to_brl(units, valor_unidade).map_err(money_error)
}

#[wasm_bindgen(js_name = unitsToReais)]
pub fn units_to_reais(units: f64, unit_value: f64) -> Result<f64, JsError> {
    dominio::money::units_to_reais(units, unit_value).map_err(money_error)
}

#[wasm_bindgen(js_name = kahanSum)]
pub fn kahan_sum(values: &[f64]) -> Result<f64, JsError> {
    dominio::money::kahan_sum(values).map_err(money_error)
}

#[wasm_bindgen(js_name = divideRoundHalfAway)]
pub fn divide_round_half_away(value: &str, divisor: &str) -> Result<String, JsError> {
    dominio::money::divide_round_half_away_text(value, divisor).map_err(money_error)
}

#[wasm_bindgen]
pub struct MoneyAccumulator {
    inner: dominio::money::MoneyAccumulator,
}

#[wasm_bindgen]
impl MoneyAccumulator {
    #[wasm_bindgen(constructor)]
    pub fn new(decimals: f64) -> Result<MoneyAccumulator, JsError> {
        dominio::money::MoneyAccumulator::new(decimals)
            .map(|inner| Self { inner })
            .map_err(money_error)
    }

    pub fn add(&mut self, value: f64) -> Result<f64, JsError> {
        self.inner.add(value).map_err(money_error)
    }

    #[wasm_bindgen(getter)]
    pub fn value(&self) -> Result<f64, JsError> {
        self.inner.value().map_err(money_error)
    }
}

#[wasm_bindgen(js_name = parseBrKickoff)]
pub fn parse_br_kickoff(text: &str, ref_ms: f64) -> Result<JsValue, JsError> {
    let parsed =
        dominio::kickoff::parse_br_kickoff(text, ref_ms).map_err(|error| JsError::new(&error.0))?;
    Ok(parsed.map_or(JsValue::NULL, |parsed| {
        JsValue::from(vec![
            JsValue::from(parsed.ms),
            JsValue::from(parsed.date_only),
        ])
    }))
}

#[wasm_bindgen(js_name = normalizeStr)]
pub fn normalize_str(text: &str) -> String {
    dominio::text_normalization::normalize_str(text)
}

#[wasm_bindgen(js_name = canonicalizeTeamName)]
pub fn canonicalize_team_name(text: &str) -> String {
    dominio::text_normalization::canonicalize_team_name(text)
}

#[wasm_bindgen(js_name = isProtectedToken)]
pub fn is_protected_token(token: &str) -> bool {
    dominio::text_normalization::is_protected_token(token)
}

fn strings<S: AsRef<str>>(items: impl IntoIterator<Item = S>) -> JsValue {
    JsValue::from(
        items
            .into_iter()
            .map(|item| JsValue::from(item.as_ref()))
            .collect::<Vec<_>>(),
    )
}

#[wasm_bindgen(js_name = teamNameVariants)]
pub fn team_name_variants(canon: &str) -> JsValue {
    strings(dominio::text_normalization::team_name_variants(canon))
}

#[wasm_bindgen(js_name = teamNameVocabulary)]
pub fn team_name_vocabulary() -> Vec<JsValue> {
    use dominio::text_normalization as names;
    vec![
        strings(names::TEAM_STOP_WORDS.iter()),
        strings(names::RESERVE_CLASS_TOKENS.iter()),
        strings([names::RESERVE_CLASS_MARKER]),
    ]
}

#[wasm_bindgen(js_name = teamNameEquivalents)]
pub fn team_name_equivalents() -> Vec<JsValue> {
    dominio::text_normalization::TEAM_NAME_EQUIVALENTS
        .iter()
        .map(|row| strings(row.iter()))
        .collect()
}

#[wasm_bindgen(js_name = regexCatalog)]
pub fn regex_catalog() -> Vec<JsValue> {
    crate::regex_probe::catalog()
        .into_iter()
        .map(|pair| JsValue::from(pair.into_iter().map(JsValue::from).collect::<Vec<_>>()))
        .collect()
}

#[wasm_bindgen(js_name = regexExec)]
pub fn regex_exec(source: &str, flags: &str, text: &str, from: u32) -> Result<JsValue, JsError> {
    let ranges = crate::regex_probe::exec(source, flags, text, from)
        .map_err(|error| JsError::new(&error))?;
    Ok(ranges.map_or(JsValue::NULL, |ranges| {
        JsValue::from(
            ranges
                .into_iter()
                .map(|at| JsValue::from(at as f64))
                .collect::<Vec<_>>(),
        )
    }))
}

#[wasm_bindgen(js_name = regexReplace)]
pub fn regex_replace(
    source: &str,
    flags: &str,
    text: &str,
    replacement: &str,
) -> Result<String, JsError> {
    crate::regex_probe::replace(source, flags, text, replacement)
        .map_err(|error| JsError::new(&error))
}

#[wasm_bindgen(js_name = regexSplit)]
pub fn regex_split(
    source: &str,
    flags: &str,
    text: &str,
    limit: Option<u32>,
) -> Result<Vec<JsValue>, JsError> {
    crate::regex_probe::split(source, flags, text, limit)
        .map(|pieces| pieces.into_iter().map(JsValue::from).collect())
        .map_err(|error| JsError::new(&error))
}

// --- team-category.ts e text.ts ---

use dominio::team_category as category;
use dominio::text as names;

fn pair_value(a: impl Into<JsValue>, b: impl Into<JsValue>) -> JsValue {
    JsValue::from(vec![a.into(), b.into()])
}

#[wasm_bindgen(js_name = protectedCategoryKey)]
pub fn protected_category_key(token: &str) -> String {
    category::protected_category_key(token).to_owned()
}

#[wasm_bindgen(js_name = teamCategoryTokens)]
pub fn team_category_tokens(canon: &str, digits_only: bool) -> JsValue {
    strings(category::team_category_tokens(canon, digits_only))
}

#[wasm_bindgen(js_name = reserveSuffixMismatch)]
pub fn reserve_suffix_mismatch(ca: &str, cb: &str) -> bool {
    category::reserve_suffix_mismatch(ca, cb)
}

#[wasm_bindgen(js_name = protectedCategoriesMismatch)]
pub fn protected_categories_mismatch(ca: &str, cb: &str) -> bool {
    category::protected_categories_mismatch(ca, cb)
}

#[wasm_bindgen(js_name = hasProtectedTeamCategoryConflict)]
pub fn has_protected_team_category_conflict(a: &str, b: &str) -> bool {
    category::has_protected_team_category_conflict(a, b)
}

#[wasm_bindgen(js_name = teamIdentityCategoryConflict)]
pub fn team_identity_category_conflict(a: &str, b: &str) -> bool {
    category::team_identity_category_conflict(a, b)
}

#[wasm_bindgen(js_name = betDeclaresCategoryFixtureLacks)]
pub fn bet_declares_category_fixture_lacks(canon_aposta: &str, canon_fixture: &str) -> bool {
    category::bet_declares_category_fixture_lacks(canon_aposta, canon_fixture)
}

#[wasm_bindgen(js_name = categoryTokensFromLeague)]
pub fn category_tokens_from_league(league: &str) -> JsValue {
    strings(category::category_tokens_from_league(league))
}

#[wasm_bindgen(js_name = leagueCoversBetCategory)]
pub fn league_covers_bet_category(
    canon_aposta: &str,
    canon_fixture: &str,
    league: Option<String>,
) -> bool {
    category::league_covers_bet_category(canon_aposta, canon_fixture, league.as_deref())
}

#[wasm_bindgen(js_name = orientedTeamPairHasReserveSuffixConflict)]
pub fn oriented_team_pair_has_reserve_suffix_conflict(
    provider_home: &str,
    provider_away: &str,
    local_home: &str,
    local_away: &str,
    swapped: bool,
    league: Option<String>,
) -> bool {
    category::oriented_team_pair_has_reserve_suffix_conflict(&category::OrientedPair {
        provider_home,
        provider_away,
        local_home,
        local_away,
        swapped,
        league: league.as_deref(),
    })
}

#[wasm_bindgen(js_name = stripCategoryTokens)]
pub fn strip_category_tokens(canon_name: &str, tokens: Vec<String>) -> String {
    category::strip_category_tokens(canon_name, &tokens)
}

#[wasm_bindgen(js_name = areCategoriesCompatible)]
pub fn are_categories_compatible(
    bet_canon: &str,
    fixture_canon: &str,
    bet_league: Option<String>,
    fixture_league: Option<String>,
) -> JsValue {
    let result = category::are_categories_compatible(
        bet_canon,
        fixture_canon,
        bet_league.as_deref(),
        fixture_league.as_deref(),
    );
    pair_value(result.compatible, strings(result.covered_tokens))
}

#[wasm_bindgen(js_name = teamCategoryConflictInContext)]
pub fn team_category_conflict_in_context(
    bet_name: &str,
    fixture_name: &str,
    bet_league: Option<String>,
    fixture_league: Option<String>,
) -> bool {
    category::team_category_conflict_in_context(
        bet_name,
        fixture_name,
        bet_league.as_deref(),
        fixture_league.as_deref(),
    )
}

#[wasm_bindgen(js_name = teamCategoryInContext)]
pub fn team_category_in_context(name: &str, league: Option<String>) -> JsValue {
    strings(category::team_category_in_context(name, league.as_deref()))
}

#[wasm_bindgen(js_name = sameTeamCategory)]
pub fn same_team_category(a: Vec<String>, b: Vec<String>) -> bool {
    category::same_team_category(&a, &b)
}

#[wasm_bindgen(js_name = isBaseCategoryFixture)]
pub fn is_base_category_fixture(home: &str, away: &str, league: Option<String>) -> bool {
    category::is_base_category_fixture(home, away, league.as_deref())
}

#[wasm_bindgen(js_name = teamSimilarity)]
pub fn team_similarity(a: &str, b: &str) -> f64 {
    names::team_similarity(a, b)
}

#[wasm_bindgen(js_name = teamSimilarityCanon)]
pub fn team_similarity_canon(ca: &str, cb: &str) -> f64 {
    names::team_similarity_canon(ca, cb)
}

#[wasm_bindgen(js_name = teamSideSimilarityCanon)]
pub fn team_side_similarity_canon(ca: &str, cb: &str) -> JsValue {
    let side = names::team_side_similarity_canon(ca, cb);
    pair_value(side.score, side.evidence)
}

#[wasm_bindgen(js_name = teamNameEvidence)]
pub fn team_name_evidence(a: &str, b: &str) -> f64 {
    names::team_name_evidence(a, b)
}

#[wasm_bindgen(js_name = fixtureHasAnchorSide)]
pub fn fixture_has_anchor_side(home_evidence: f64, away_evidence: f64) -> bool {
    names::fixture_has_anchor_side(home_evidence, away_evidence)
}

#[wasm_bindgen(js_name = textThresholds)]
pub fn text_thresholds() -> Vec<JsValue> {
    vec![
        JsValue::from(names::ANCHOR_SIDE_FLOOR),
        JsValue::from(names::SAME_FIXTURE_MIN_SIMILARITY),
    ]
}

#[wasm_bindgen(js_name = bestSearchWord)]
pub fn best_search_word(text: &str) -> String {
    names::best_search_word(text)
}

#[wasm_bindgen(js_name = splitEventoTeams)]
pub fn split_evento_teams(evento: &str) -> JsValue {
    names::split_evento_teams(evento).map_or(JsValue::NULL, |(home, away)| pair_value(home, away))
}

#[wasm_bindgen(js_name = fixtureHasPlaceholderTeam)]
pub fn fixture_has_placeholder_team(evento: &str) -> bool {
    names::fixture_has_placeholder_team(evento)
}

#[wasm_bindgen(js_name = sameFixtureTeams)]
pub fn same_fixture_teams(evento_a: &str, evento_b: &str) -> bool {
    names::same_fixture_teams(evento_a, evento_b)
}

#[wasm_bindgen(js_name = slugify)]
pub fn slugify(text: &str) -> String {
    names::slugify(text)
}

#[wasm_bindgen(js_name = matchTeamsWithCategoryContext)]
#[allow(clippy::too_many_arguments)]
pub fn match_teams_with_category_context(
    bet_home: &str,
    bet_away: &str,
    fixture_home: &str,
    fixture_away: &str,
    bet_league: Option<String>,
    fixture_league: Option<String>,
    canonical: bool,
) -> Vec<JsValue> {
    let pair = names::CanonFixturePair {
        bet_home,
        bet_away,
        fixture_home,
        fixture_away,
        bet_league: bet_league.as_deref(),
        fixture_league: fixture_league.as_deref(),
    };
    let result = if canonical {
        names::match_canon_teams_with_category_context(&pair)
    } else {
        names::match_teams_with_category_context(&pair)
    };
    let flag = |value: bool| if value { 1.0 } else { 0.0 };
    [
        result.direct_home,
        result.direct_away,
        result.inverted_home,
        result.inverted_away,
        result.direct,
        result.inverted,
        flag(result.swapped),
        result.score,
        flag(result.compatible),
        flag(result.anchored),
        result.evidence_home,
        result.evidence_away,
    ]
    .into_iter()
    .map(JsValue::from)
    .collect()
}

#[wasm_bindgen(js_name = refineCategoryCandidates)]
#[allow(clippy::too_many_arguments)]
pub fn refine_category_candidates(
    bet_home: &str,
    bet_away: &str,
    bet_league: Option<String>,
    bet_kickoff_ms: Option<f64>,
    collapse_duplicate_listings: bool,
    homes: Vec<String>,
    aways: Vec<String>,
    leagues: Vec<String>,
    countries: Vec<String>,
    kickoffs: Vec<f64>,
    swapped: Vec<u32>,
) -> Vec<JsValue> {
    crate::refine_candidates(
        &names::CategoryRefinement {
            bet_home,
            bet_away,
            bet_league: bet_league.as_deref(),
            bet_kickoff_ms,
            collapse_duplicate_listings,
        },
        [homes, aways, leagues, countries],
        &kickoffs,
        &swapped,
    )
    .into_iter()
    .map(JsValue::from)
    .collect()
}

#[wasm_bindgen(js_name = markSoccerReserveTeams)]
pub fn mark_soccer_reserve_teams(evento: &str, selecao: &str) -> JsValue {
    names::mark_soccer_reserve_teams(evento, selecao).map_or(JsValue::NULL, |(evento, selecao)| {
        pair_value(evento, selecao)
    })
}
