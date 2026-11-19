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

#[wasm_bindgen(js_name = teamStopWords)]
pub fn team_stop_words() -> JsValue {
    strings(dominio::text_normalization::TEAM_STOP_WORDS.iter())
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

#[wasm_bindgen(js_name = teamCategoryTokens)]
pub fn team_category_tokens(canon: &str, digits_only: bool) -> JsValue {
    strings(category::team_category_tokens(canon, digits_only))
}

#[wasm_bindgen(js_name = reserveSuffixMismatch)]
pub fn reserve_suffix_mismatch(ca: &str, cb: &str) -> bool {
    category::reserve_suffix_mismatch(ca, cb)
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

#[wasm_bindgen(js_name = anchorSideFloor)]
pub fn anchor_side_floor() -> f64 {
    names::ANCHOR_SIDE_FLOOR
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

// --- mercados/ ---

use dominio::mercados::{accents, match_scope, total_direction, trailing_side};

fn optional_string(value: Option<String>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

#[wasm_bindgen]
pub fn accentuate(term: &str) -> String {
    accents::accentuate(term)
}

#[wasm_bindgen(js_name = accentVariants)]
pub fn accent_variants(term: &str) -> JsValue {
    strings(accents::accent_variants(term))
}

#[wasm_bindgen(js_name = scopeNouns)]
pub fn scope_nouns() -> Vec<JsValue> {
    vec![
        strings(match_scope::MATCH_SCOPE_NOUNS.iter()),
        strings(match_scope::SIDE_SCOPE_NOUNS.iter()),
    ]
}

#[wasm_bindgen(js_name = trailingTeamCandidate)]
pub fn trailing_team_candidate(trailing: &str) -> JsValue {
    optional_string(trailing_side::trailing_team_candidate(trailing))
}

#[wasm_bindgen(js_name = trailingTeamCandidateOfSelection)]
pub fn trailing_team_candidate_of_selection(selecao: &str) -> JsValue {
    optional_string(trailing_side::trailing_team_candidate_of_selection(selecao))
}

#[wasm_bindgen(js_name = separateCompactStatUnit)]
pub fn separate_compact_stat_unit(text: &str) -> String {
    total_direction::separate_compact_stat_unit(text)
}

#[wasm_bindgen(js_name = expandAbbreviatedDirection)]
pub fn expand_abbreviated_direction(selection: &str) -> String {
    total_direction::expand_abbreviated_direction(selection)
}

#[wasm_bindgen(js_name = totalDirectionWords)]
pub fn total_direction_words() -> Vec<JsValue> {
    vec![
        JsValue::from(total_direction::OVER_WORDS),
        JsValue::from(total_direction::UNDER_WORDS),
    ]
}

#[wasm_bindgen(js_name = totalDirectionOf)]
pub fn total_direction_of(selection: &str, allow_bare_positive_line: bool) -> JsValue {
    optional_string(
        total_direction::total_direction_of(selection, allow_bare_positive_line).map(|direction| {
            match direction {
                total_direction::TotalDirection::Over => "over".to_owned(),
                total_direction::TotalDirection::Under => "under".to_owned(),
            }
        }),
    )
}

use dominio::mercados::{catalog, draw_vocabulary};

fn optional_str(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

fn lists(items: impl IntoIterator<Item = Vec<String>>) -> JsValue {
    JsValue::from(items.into_iter().map(strings).collect::<Vec<_>>())
}

#[wasm_bindgen(js_name = mercadosIntermediarios)]
pub fn mercados_intermediarios() -> JsValue {
    strings(catalog::MERCADOS_INTERMEDIARIOS)
}

#[wasm_bindgen(js_name = mercadoTranslations)]
pub fn mercado_translations() -> JsValue {
    JsValue::from(
        catalog::MERCADO_TRANSLATIONS
            .iter()
            .map(|(from, to)| pair_value(*from, *to))
            .collect::<Vec<_>>(),
    )
}

#[wasm_bindgen(js_name = normalizeMercadoKey)]
pub fn normalize_mercado_key(text: &str) -> String {
    catalog::normalize_mercado_key(text)
}

#[wasm_bindgen(js_name = resolveMercadoCanonical)]
pub fn resolve_mercado_canonical(raw: &str) -> JsValue {
    optional_str(catalog::resolve_mercado_canonical(raw))
}

#[wasm_bindgen(js_name = resolveMercadoStatic)]
pub fn resolve_mercado_static(raw: &str) -> JsValue {
    optional_str(catalog::resolve_mercado_static(raw))
}

#[wasm_bindgen(js_name = isMercadoFinal)]
pub fn is_mercado_final(mercado: &str) -> bool {
    catalog::is_mercado_final(mercado)
}

#[wasm_bindgen(js_name = drawVocabulary)]
pub fn draw_vocabulary() -> JsValue {
    let dnb = &draw_vocabulary::DRAW_NO_BET_VOCABULARY;
    let dc = &draw_vocabulary::DOUBLE_CHANCE_VOCABULARY;
    JsValue::from(
        [
            dnb.standalone,
            dnb.abbreviations,
            dnb.verbs,
            dnb.objects,
            dnb.states,
            dnb.nouns,
            dnb.noun_qualifiers,
            dnb.connectors,
            dc.standalone,
            dc.abbreviations,
            dc.terms,
        ]
        .into_iter()
        .map(strings)
        .collect::<Vec<_>>(),
    )
}

#[wasm_bindgen(js_name = stripDrawNoBetFromSelection)]
pub fn strip_draw_no_bet_from_selection(selecao: &str) -> JsValue {
    optional_string(draw_vocabulary::strip_draw_no_bet_from_selection(selecao))
}

#[wasm_bindgen(js_name = stripDoubleChanceFromSelection)]
pub fn strip_double_chance_from_selection(selecao: &str) -> JsValue {
    optional_string(draw_vocabulary::strip_double_chance_from_selection(selecao))
}

#[wasm_bindgen(js_name = drawNoBetSqlTerms)]
pub fn draw_no_bet_sql_terms() -> JsValue {
    lists(draw_vocabulary::draw_no_bet_sql_terms())
}

#[wasm_bindgen(js_name = doubleChanceSqlTerms)]
pub fn double_chance_sql_terms() -> JsValue {
    lists(draw_vocabulary::double_chance_sql_terms())
}

use dominio::mercados::stat_qualifier;

#[wasm_bindgen(js_name = nonScoreStatTerms)]
pub fn non_score_stat_terms() -> String {
    stat_qualifier::NON_SCORE_STAT_TERMS.to_owned()
}

/// `[terms, sports]` de gols, corridas e pontos, nessa ordem.
#[wasm_bindgen(js_name = scoreUnitRules)]
pub fn score_unit_rules() -> Vec<JsValue> {
    stat_qualifier::SCORE_UNIT_RULES
        .iter()
        .map(|rule| pair_value(strings(rule.terms.iter()), strings(rule.sports.iter())))
        .collect()
}

#[wasm_bindgen(js_name = isBothTeamsCardsText)]
pub fn is_both_teams_cards_text(text: &str) -> bool {
    stat_qualifier::is_both_teams_cards_text(text)
}

#[wasm_bindgen(js_name = selecaoDeclaraLinhaDeEstatistica)]
pub fn selecao_declara_linha_de_estatistica(selecao: &str) -> bool {
    stat_qualifier::selecao_declara_linha_de_estatistica(selecao)
}

#[wasm_bindgen(js_name = hasNonScoreStatQualifier)]
pub fn has_non_score_stat_qualifier(mercado: &str, selecao: &str) -> bool {
    stat_qualifier::has_non_score_stat_qualifier(mercado, selecao)
}

#[wasm_bindgen(js_name = hasUnknownScoreQualifier)]
pub fn has_unknown_score_qualifier(mercado: &str) -> bool {
    stat_qualifier::has_unknown_score_qualifier(mercado)
}

#[wasm_bindgen(js_name = knownScoreQualifierSqlTerms)]
pub fn known_score_qualifier_sql_terms() -> JsValue {
    strings(stat_qualifier::known_score_qualifier_sql_terms())
}

#[wasm_bindgen(js_name = nonScoreStatSqlTerms)]
pub fn non_score_stat_sql_terms() -> JsValue {
    strings(stat_qualifier::non_score_stat_sql_terms())
}

#[wasm_bindgen(js_name = scoreUnitTermsForSql)]
pub fn score_unit_terms_for_sql() -> JsValue {
    strings(stat_qualifier::score_unit_terms_for_sql())
}

#[wasm_bindgen(js_name = hasScoreUnitMismatch)]
pub fn has_score_unit_mismatch(mercado: &str, selecao: &str, esporte: Option<String>) -> bool {
    stat_qualifier::has_score_unit_mismatch(mercado, selecao, esporte.as_deref())
}

#[wasm_bindgen(js_name = hasSportScoreUnitMismatch)]
pub fn has_sport_score_unit_mismatch(
    mercado: &str,
    selecao: &str,
    esporte: Option<String>,
) -> bool {
    stat_qualifier::has_sport_score_unit_mismatch(mercado, selecao, esporte.as_deref())
}

// --- sports/ ---

use dominio::sports::{detect, registry};

fn decision_columns(decision: detect::Decision) -> JsValue {
    let evidence = &decision.evidence;
    JsValue::from(vec![
        decision.sport.map_or(JsValue::NULL, JsValue::from),
        JsValue::from(decision.status.as_str()),
        JsValue::from(decision.confidence),
        JsValue::from(decision.source.as_str()),
        strings(evidence.iter().map(|item| item.source.as_str())),
        strings(evidence.iter().map(|item| item.sport)),
        JsValue::from(
            evidence
                .iter()
                .map(|item| JsValue::from(item.confidence))
                .collect::<Vec<_>>(),
        ),
        strings(evidence.iter().map(|item| item.value.as_str())),
    ])
}

#[wasm_bindgen(js_name = canonicalSport)]
pub fn canonical_sport(value: Option<String>) -> JsValue {
    optional_str(registry::canonical_sport(value.as_deref().unwrap_or("")))
}

#[wasm_bindgen(js_name = esportesComUnidade)]
pub fn esportes_com_unidade(unidade: &str) -> JsValue {
    strings(
        registry::UnidadeDoPlacar::parse(unidade)
            .map_or_else(Vec::new, registry::esportes_com_unidade),
    )
}

#[wasm_bindgen(js_name = termosDeUnidadeSemPlacar)]
pub fn termos_de_unidade_sem_placar() -> JsValue {
    strings(registry::termos_de_unidade_sem_placar())
}

#[wasm_bindgen(js_name = sportDetectionConstants)]
pub fn sport_detection_constants() -> JsValue {
    JsValue::from(vec![
        JsValue::from(detect::SPORT_RESOLVER_VERSION),
        JsValue::from(detect::SPORT_AUTO_CONFIRM_MIN_CONFIDENCE),
        JsValue::from(detect::SPORT_DISSENT_MIN_CONFIDENCE),
        JsValue::from(detect::SHARED_SOCCER_LEAGUE),
    ])
}

#[wasm_bindgen(js_name = detectSportFromText)]
pub fn detect_sport_from_text(text: &str, item_sport: Option<String>) -> JsValue {
    decision_columns(detect::detect_sport_from_text(text, item_sport.as_deref()))
}

#[wasm_bindgen(js_name = llmSportDecision)]
pub fn llm_sport_decision(
    sport: Option<String>,
    confidence: Option<f64>,
    evidence_text: Option<String>,
) -> JsValue {
    decision_columns(detect::llm_sport_decision(
        sport.as_deref(),
        confidence,
        evidence_text.as_deref(),
    ))
}

// --- countries e national-teams ---

use dominio::{countries, national_teams};

fn pairs(table: &[(&str, &str)]) -> JsValue {
    JsValue::from(
        table
            .iter()
            .map(|(key, value)| pair_value(*key, *value))
            .collect::<Vec<_>>(),
    )
}

#[wasm_bindgen(js_name = countryTables)]
pub fn country_tables() -> Vec<JsValue> {
    vec![
        pairs(countries::NATIONAL_TEAMS_PT_EN),
        pairs(countries::CANONICAL_COUNTRY_MAP),
        strings(countries::KNOWN_COUNTRY_KEYS.iter()),
    ]
}

#[wasm_bindgen(js_name = translateNationalTeamPtToEn)]
pub fn translate_national_team_pt_to_en(local_name: &str) -> JsValue {
    optional_str(national_teams::translate_national_team_pt_to_en(local_name))
}

#[wasm_bindgen(js_name = canonicalCountry)]
pub fn canonical_country(raw: &str) -> String {
    national_teams::canonical_country(raw)
}

#[wasm_bindgen(js_name = canonicalCompetition)]
pub fn canonical_competition(raw: &str, pais: Option<String>) -> String {
    national_teams::canonical_competition(raw, pais.as_deref())
}

#[wasm_bindgen(js_name = rewriteNationalTeamsInText)]
pub fn rewrite_national_teams_in_text(text: &str, event_teams: Option<Vec<String>>) -> String {
    let teams: Option<Vec<&str>> = event_teams
        .as_ref()
        .map(|teams| teams.iter().map(String::as_str).collect());
    national_teams::rewrite_national_teams_in_text(text, teams.as_deref())
}

#[wasm_bindgen(js_name = rewriteSelecaoWithMatchedTeams)]
pub fn rewrite_selecao_with_matched_teams(
    selecao: &str,
    local_home: &str,
    local_away: &str,
    pinnacle_home: &str,
    pinnacle_away: &str,
) -> String {
    national_teams::rewrite_selecao_with_matched_teams(
        selecao,
        local_home,
        local_away,
        pinnacle_home,
        pinnacle_away,
    )
}

// --- settlement/ ---

use dominio::settlement::sides::{self, Outcome, Side};

fn side_value(side: Option<Side>) -> JsValue {
    optional_str(side.map(Side::as_str))
}

#[wasm_bindgen(js_name = stripTeamNames)]
pub fn strip_team_names(selecao: &str, evento: &str) -> String {
    sides::strip_team_names(selecao, evento)
}

#[wasm_bindgen(js_name = matchTeamSide)]
pub fn match_team_side(selecao: &str, evento: &str) -> JsValue {
    side_value(sides::match_team_side(selecao, evento))
}

#[wasm_bindgen(js_name = matchMoneylineSelection)]
pub fn match_moneyline_selection(selecao: &str, evento: &str, strict: bool) -> JsValue {
    optional_str(sides::match_moneyline_selection(selecao, evento, strict).map(Outcome::as_str))
}

#[wasm_bindgen(js_name = moneylineSelectionAsksAnotherMarket)]
pub fn moneyline_selection_asks_another_market(selecao: &str, evento: Option<String>) -> bool {
    sides::moneyline_selection_asks_another_market(selecao, evento.as_deref())
}

/// `[side, contradicts]`.
#[wasm_bindgen(js_name = resolveSideFromMarketAndSelection)]
pub fn resolve_side_from_market_and_selection(
    mercado: &str,
    selecao: &str,
    evento: &str,
) -> JsValue {
    let (side, contradicts) =
        sides::resolve_side_from_market_and_selection(mercado, selecao, evento);
    pair_value(side_value(side), contradicts)
}

#[wasm_bindgen(js_name = matchDrawNoBetSelection)]
pub fn match_draw_no_bet_selection(selecao: &str, evento: &str) -> JsValue {
    side_value(sides::match_draw_no_bet_selection(selecao, evento))
}

#[wasm_bindgen(js_name = matchDoubleChanceSelection)]
pub fn match_double_chance_selection(selecao: &str, evento: &str) -> JsValue {
    sides::match_double_chance_selection(selecao, evento).map_or(JsValue::NULL, |(one, other)| {
        strings([one.as_str(), other.as_str()])
    })
}

use dominio::mercados::classify;

/// `[[EXTRA_TIME_PATTERN, REGULATION_TIME_PATTERN], [escopos de outright,
/// frases de vencedor, 1º tempo, 2º tempo, siglas do 1º, siglas do 2º]]`.
#[wasm_bindgen(js_name = classifyData)]
pub fn classify_data() -> JsValue {
    pair_value(
        strings([
            classify::EXTRA_TIME_PATTERN,
            classify::REGULATION_TIME_PATTERN,
        ]),
        JsValue::from(vec![
            strings(classify::OUTRIGHT_SCOPE_NOUNS),
            strings(classify::OUTRIGHT_WINNER_PHRASES),
            strings(classify::HALF_PERIOD_PHRASES_FIRST),
            strings(classify::HALF_PERIOD_PHRASES_SECOND),
            strings(classify::HALF_PERIOD_ABBREVIATIONS_FIRST),
            strings(classify::HALF_PERIOD_ABBREVIATIONS_SECOND),
        ]),
    )
}

#[wasm_bindgen(js_name = isEsports)]
pub fn is_esports(esporte: Option<String>) -> bool {
    classify::is_esports(esporte.as_deref())
}

#[wasm_bindgen(js_name = marketMapNumberOf)]
pub fn market_map_number_of(mercado: &str, esporte: Option<String>) -> JsValue {
    // `Option<u32>` vazio chegaria como `undefined`; o TS devolvia `null`.
    classify::market_map_number_of(mercado, esporte.as_deref()).map_or(JsValue::NULL, JsValue::from)
}

#[wasm_bindgen(js_name = marketIncludesExtraTime)]
pub fn market_includes_extra_time(mercado: &str) -> bool {
    classify::market_includes_extra_time(mercado)
}

#[wasm_bindgen(js_name = declaresRegulationTime)]
pub fn declares_regulation_time(text: &str) -> bool {
    classify::declares_regulation_time(text)
}

#[wasm_bindgen(js_name = isBttsMarket)]
pub fn is_btts_market(mercado: &str) -> bool {
    classify::is_btts_market(mercado)
}

#[wasm_bindgen(js_name = marketNamesBothHalves)]
pub fn market_names_both_halves(text: &str) -> bool {
    classify::market_names_both_halves(text)
}

#[wasm_bindgen(js_name = isCombinedBttsMarket)]
pub fn is_combined_btts_market(mercado: &str) -> bool {
    classify::is_combined_btts_market(mercado)
}

#[wasm_bindgen(js_name = bttsSelectionSide)]
pub fn btts_selection_side(selecao: &str) -> JsValue {
    optional_str(classify::btts_selection_side(selecao).map(classify::BttsSide::as_str))
}

#[wasm_bindgen(js_name = isRaceToMarket)]
pub fn is_race_to_market(mercado: &str, selecao: &str) -> bool {
    classify::is_race_to_market(mercado, selecao)
}

#[wasm_bindgen(js_name = isThreeWayHandicapMarket)]
pub fn is_three_way_handicap_market(mercado: &str) -> bool {
    classify::is_three_way_handicap_market(mercado)
}

#[wasm_bindgen(js_name = isOutrightMarket)]
pub fn is_outright_market(mercado: &str) -> bool {
    classify::is_outright_market(mercado)
}

#[wasm_bindgen(js_name = isMethodOfVictoryMarket)]
pub fn is_method_of_victory_market(mercado: &str) -> bool {
    classify::is_method_of_victory_market(mercado)
}

#[wasm_bindgen(js_name = isDrawNoBetMarket)]
pub fn is_draw_no_bet_market(mercado: &str) -> bool {
    classify::is_draw_no_bet_market(mercado)
}

#[wasm_bindgen(js_name = isDoubleChanceMarket)]
pub fn is_double_chance_market(mercado: &str) -> bool {
    classify::is_double_chance_market(mercado)
}

#[wasm_bindgen(js_name = totalLabelSide)]
pub fn total_label_side(mercado: &str, evento: &str) -> JsValue {
    side_value(classify::total_label_side(mercado, evento))
}

#[wasm_bindgen(js_name = isTeamTotalMarket)]
pub fn is_team_total_market(mercado: &str, selecao: &str, evento: Option<String>) -> bool {
    classify::is_team_total_market(mercado, selecao, evento.as_deref())
}

#[wasm_bindgen(js_name = marketPeriodOf)]
pub fn market_period_of(mercado: &str, esporte: Option<String>) -> String {
    classify::market_period_of(mercado, esporte.as_deref())
        .as_str()
        .to_owned()
}

#[wasm_bindgen(js_name = marketKindOf)]
pub fn market_kind_of(mercado: &str, selecao: &str, evento: Option<String>) -> String {
    classify::market_kind_of(mercado, selecao, evento.as_deref())
        .as_str()
        .to_owned()
}

use dominio::mercados::{compatibility, finalize};

fn sport_names(list: &[compatibility::MarketSport]) -> JsValue {
    strings(list.iter().map(|sport| sport.as_str()))
}

/// `[[rótulo final, esportes][], [regulamentar: moneyline, spread, total], esportes com prorrogação]`.
#[wasm_bindgen(js_name = compatibilityData)]
pub fn compatibility_data() -> Vec<JsValue> {
    let finals: Vec<JsValue> = compatibility::FINAL_MARKET_SPORTS
        .iter()
        .map(|(market, list)| pair_value(*market, sport_names(list)))
        .collect();
    vec![
        JsValue::from(finals),
        strings([
            compatibility::REGULATION_TIME_MONEYLINE,
            compatibility::REGULATION_TIME_SPREAD,
            compatibility::REGULATION_TIME_TOTAL,
        ]),
        sport_names(compatibility::REGULATION_TIME_SPORTS),
    ]
}

#[wasm_bindgen(js_name = marketSportOf)]
pub fn market_sport_of(esporte: Option<String>) -> String {
    compatibility::market_sport_of(esporte.as_deref())
        .as_str()
        .to_owned()
}

#[wasm_bindgen(js_name = restrictsToRegulationTime)]
pub fn restricts_to_regulation_time(text: &str, esporte: Option<String>) -> bool {
    compatibility::restricts_to_regulation_time(text, esporte.as_deref())
}

#[wasm_bindgen(js_name = regulationTimeBaseOf)]
pub fn regulation_time_base_of(mercado: &str) -> JsValue {
    optional_str(compatibility::regulation_time_base_of(mercado))
}

#[wasm_bindgen(js_name = isRegulationTimeMarket)]
pub fn is_regulation_time_market(mercado: &str) -> bool {
    compatibility::is_regulation_time_market(mercado)
}

#[wasm_bindgen(js_name = isMercadoFinalForSport)]
pub fn is_mercado_final_for_sport(mercado: &str, esporte: Option<String>) -> bool {
    compatibility::is_mercado_final_for_sport(mercado, esporte.as_deref())
}

#[wasm_bindgen(js_name = finalizePinnacleMarket)]
pub fn finalize_pinnacle_market(mercado: &str, esporte: Option<String>) -> String {
    finalize::finalize_pinnacle_market(mercado, esporte.as_deref())
}

#[wasm_bindgen(js_name = regulationTimeMarket)]
pub fn regulation_time_market(
    mercado: &str,
    selecao: &str,
    evento: &str,
    esporte: Option<String>,
    declared: bool,
) -> String {
    finalize::regulation_time_market(mercado, selecao, evento, esporte.as_deref(), declared)
}

#[wasm_bindgen(js_name = pinnacleizeMercado)]
pub fn pinnacleize_mercado(mercado: &str, esporte: Option<String>) -> String {
    finalize::pinnacleize_mercado(mercado, esporte.as_deref())
}

#[wasm_bindgen(js_name = keepDeclaredPeriod)]
pub fn keep_declared_period(
    original: &str,
    coerced: &str,
    esporte: Option<String>,
    selecao: &str,
) -> String {
    finalize::keep_declared_period(original, coerced, esporte.as_deref(), selecao)
}

use dominio::mercados::{double_chance_selection, sharp_equivalent};

/// `[mercado, selecao]` canônicos, ou `null` quando não é Dupla Chance.
#[wasm_bindgen(js_name = canonicalDoubleChanceSelection)]
pub fn canonical_double_chance_selection(
    evento: &str,
    mercado: &str,
    selecao: &str,
    esporte: &str,
) -> JsValue {
    double_chance_selection::canonical_double_chance_selection(evento, mercado, selecao, esporte)
        .map_or(JsValue::NULL, |(mercado, selecao)| {
            strings([mercado, selecao])
        })
}

#[wasm_bindgen(js_name = supportsSharpEquivalence)]
pub fn supports_sharp_equivalence(esporte: Option<String>) -> bool {
    sharp_equivalent::supports_sharp_equivalence(esporte.as_deref())
}

/// `[mercado, selecao, nota]`, ou `null` sem equivalente.
#[wasm_bindgen(js_name = sharpEquivalentBet)]
pub fn sharp_equivalent_bet(
    mercado: &str,
    selecao: &str,
    evento: &str,
    esporte: Option<String>,
) -> JsValue {
    sharp_equivalent::sharp_equivalent_bet(mercado, selecao, evento, esporte.as_deref())
        .map_or(JsValue::NULL, |bet| {
            strings([bet.mercado, &bet.selecao, bet.nota])
        })
}

use dominio::settlement::lines;

fn optional_number(value: Option<f64>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

#[wasm_bindgen(js_name = unknownLineSeparator)]
pub fn unknown_line_separator() -> String {
    lines::UNKNOWN_LINE_SEPARATOR.to_owned()
}

#[wasm_bindgen(js_name = lineToQuarters)]
pub fn line_to_quarters(line: f64) -> JsValue {
    optional_number(lines::line_to_quarters(line))
}

#[wasm_bindgen(js_name = withoutNumberedHalf)]
pub fn without_numbered_half(text: &str) -> String {
    lines::without_numbered_half(text)
}

/// `number[]`: o `Vec<f64>` do `wasm-bindgen` chegaria como `Float64Array`.
#[wasm_bindgen(js_name = extractSignedNumbers)]
pub fn extract_signed_numbers(text: &str) -> JsValue {
    JsValue::from(
        lines::extract_signed_numbers(text)
            .into_iter()
            .map(JsValue::from)
            .collect::<Vec<_>>(),
    )
}

#[wasm_bindgen(js_name = parseLineQuarters)]
pub fn parse_line_quarters(selecao: &str, allow_negative: bool) -> JsValue {
    optional_number(lines::parse_line_quarters(selecao, allow_negative))
}

#[wasm_bindgen(js_name = statusFromAdjustedQuarters)]
pub fn status_from_adjusted_quarters(adjusted: f64) -> String {
    lines::status_from_adjusted_quarters(adjusted).to_owned()
}

use dominio::bookmaker;
use dominio::settlement::goalscorer_matching as scorer;

fn numbers(items: impl IntoIterator<Item = f64>) -> JsValue {
    JsValue::from(items.into_iter().map(JsValue::from).collect::<Vec<_>>())
}

#[wasm_bindgen(js_name = canonicalizeBookmakerName)]
pub fn canonicalize_bookmaker_name(value: &str) -> String {
    bookmaker::canonicalize_bookmaker_name(value)
}

/// `[similaridade mínima, vantagem mínima]`.
#[wasm_bindgen(js_name = goalscorerThresholds)]
pub fn goalscorer_thresholds() -> JsValue {
    numbers([
        scorer::GOALSCORER_MIN_SIMILARIDADE,
        scorer::GOALSCORER_MIN_VANTAGEM,
    ])
}

#[wasm_bindgen(js_name = tokensDoNome)]
pub fn tokens_do_nome(nome: &str) -> JsValue {
    strings(scorer::tokens_do_nome(nome))
}

#[wasm_bindgen(js_name = similaridadeDeTokens)]
pub fn similaridade_de_tokens(ta: Vec<String>, tb: Vec<String>) -> f64 {
    scorer::similaridade_de_tokens(&ta, &tb)
}

#[wasm_bindgen(js_name = tokensDaSelecao)]
pub fn tokens_da_selecao(selecao: &str) -> JsValue {
    strings(scorer::tokens_da_selecao(selecao))
}

#[wasm_bindgen(js_name = temPolaridadeNegativa)]
pub fn tem_polaridade_negativa(textos: Vec<String>) -> bool {
    scorer::tem_polaridade_negativa(&textos)
}

#[wasm_bindgen(js_name = playerMatchRefusals)]
pub fn player_match_refusals() -> JsValue {
    strings(
        scorer::PLAYER_MATCH_REFUSALS
            .iter()
            .map(|reason| reason.as_str()),
    )
}

/// `nomesCurtos[i]` vazio é o jogador sem abreviado.
#[wasm_bindgen(js_name = encontrarJogadorNaPartida)]
pub fn encontrar_jogador_na_partida(
    selecao: &str,
    nomes: Vec<String>,
    nomes_curtos: Vec<String>,
) -> JsValue {
    let jogadores: Vec<scorer::NamedPlayer> = nomes
        .iter()
        .enumerate()
        .map(|(i, nome)| scorer::NamedPlayer {
            nome,
            nome_curto: nomes_curtos.get(i).map(String::as_str),
        })
        .collect();
    numbers(scorer::encontrar_jogador_na_partida(selecao, &jogadores).encoded())
}

#[wasm_bindgen(js_name = participationUnproven)]
pub fn participation_unproven(minutos_publicados: bool, participou: bool, sem_gols: bool) -> bool {
    scorer::participation_unproven(minutos_publicados, participou, sem_gols)
}

#[wasm_bindgen(js_name = listedButDidNotPlay)]
pub fn listed_but_did_not_play(minutos: Option<f64>, participou: bool, sem_gols: bool) -> bool {
    scorer::listed_but_did_not_play(minutos, participou, sem_gols)
}

use dominio::settlement::over_under_subject as subject;

#[wasm_bindgen(js_name = prefixoAntesDaLinha)]
pub fn prefixo_antes_da_linha(selecao: &str) -> JsValue {
    optional_string(subject::prefixo_antes_da_linha(selecao))
}

#[wasm_bindgen(js_name = subjectAfterLine)]
pub fn subject_after_line(selecao: &str, evento: Option<String>) -> JsValue {
    optional_string(subject::subject_after_line(selecao, evento.as_deref()))
}

#[wasm_bindgen(js_name = lineSubjectIsNotEventTeam)]
pub fn line_subject_is_not_event_team(selecao: &str, evento: Option<String>) -> bool {
    subject::line_subject_is_not_event_team(selecao, evento.as_deref())
}
