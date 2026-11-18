//! Lado N-API da ponte (web e worker, `index.cjs`).

use dominio::cron;
use napi::{Error, Result};
use napi_derive::napi;

/// Versão do binário, para o empacotamento conferir que ele carrega.
#[napi]
pub fn versao() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

fn js_error(error: cron::CronError) -> Error {
    Error::from_reason(error.to_string())
}

#[napi]
pub fn cron_max_gap_minutes(cron: String) -> Result<u32> {
    cron::cron_max_gap_minutes(&cron).map_err(js_error)
}

#[napi]
pub fn cron_firing_minutes(cron: String) -> Result<Vec<u32>> {
    cron::cron_firing_minutes(&cron).map_err(js_error)
}

/// Instantes em milissegundos da época (`Date.getTime()`); `null` sem disparo.
#[napi]
pub fn latest_cron_firing(
    cron: String,
    after_ms: f64,
    until_ms: f64,
    utc_offset_hours: f64,
) -> Result<Option<f64>> {
    cron::latest_cron_firing(&cron, after_ms, until_ms, utc_offset_hours).map_err(js_error)
}

/// `[probabilidade implícita, estimada, fração de Kelly]`; `null` quando a
/// vantagem e a odd não dão probabilidade possível.
#[napi]
pub fn analyze_kelly(odds: f64, vantagem_pct: f64) -> Option<Vec<f64>> {
    dominio::kelly::analyze_kelly(odds, vantagem_pct).map(|analysis| {
        vec![
            analysis.implied_probability,
            analysis.estimated_probability,
            analysis.full_fraction,
        ]
    })
}

#[napi]
pub fn kelly_stake(odds: f64, vantagem_pct: f64, fraction: f64, cap_units: f64) -> f64 {
    dominio::kelly::kelly_stake(odds, vantagem_pct, fraction, cap_units)
}

/// Ver `src/domain/decimal-input.ts`: só o texto; a casca trata o resto.
#[napi]
pub fn parse_decimal_text(value: String) -> Option<f64> {
    dominio::decimal_input::parse_decimal_text(&value)
}

#[napi]
pub fn parse_money_text(value: String) -> Option<f64> {
    dominio::decimal_input::parse_money_text(&value)
}

/// Ver `src/domain/odds.ts`: listas de odds entram como `Array` e saem como
/// `Array` ou `null`.
#[napi]
pub fn power_fair_probs(odds: Vec<f64>) -> Option<Vec<f64>> {
    dominio::odds::power_fair_probs(&odds)
}

#[napi]
pub fn shin_fair_probs(odds: Vec<f64>) -> Option<Vec<f64>> {
    dominio::odds::shin_fair_probs(&odds)
}

#[napi]
pub fn power_fair_odds(odds: Vec<f64>) -> Option<Vec<f64>> {
    dominio::odds::power_fair_odds(&odds)
}

#[napi]
pub fn shin_fair_odds(odds: Vec<f64>) -> Option<Vec<f64>> {
    dominio::odds::shin_fair_odds(&odds)
}

#[napi]
pub fn auto_fair_odds(odds: Vec<f64>) -> Option<Vec<f64>> {
    dominio::odds::auto_fair_odds(&odds)
}

#[napi]
pub fn auto_fair_probs(odds: Vec<f64>) -> Option<Vec<f64>> {
    dominio::odds::auto_fair_probs(&odds)
}

#[napi]
pub fn combine_quarter_line_odds(
    side: String,
    a_line_q: f64,
    a_odd: f64,
    b_line_q: f64,
    b_odd: f64,
) -> Option<f64> {
    use dominio::odds::QuarterLineComponent;
    dominio::odds::combine_quarter_line_odds(
        &side,
        QuarterLineComponent {
            line_q: a_line_q,
            odd: a_odd,
        },
        QuarterLineComponent {
            line_q: b_line_q,
            odd: b_odd,
        },
    )
}

#[napi]
pub fn percentual_contra_fair(book_odd: f64, fair_odd: f64) -> Option<f64> {
    dominio::odds::percentual_contra_fair(book_odd, fair_odd)
}

/// Ver `src/domain/dates.ts`: instantes em milissegundos desde a época.
fn date_error(error: dominio::dates::DateError) -> Error {
    Error::from_reason(error.0)
}

#[napi]
pub fn sp_day_key(ms: f64) -> Result<String> {
    dominio::dates::sp_day_key(ms).map_err(date_error)
}

#[napi]
pub fn format_sp_time(ms: f64) -> String {
    dominio::dates::format_sp_time(ms)
}

#[napi]
pub fn format_sp_day_month(ms: f64) -> String {
    dominio::dates::format_sp_day_month(ms)
}

#[napi]
pub fn format_sp_date_time(ms: f64) -> String {
    dominio::dates::format_sp_date_time(ms)
}

#[napi]
pub fn format_sp_date_with_year(ms: f64) -> String {
    dominio::dates::format_sp_date_with_year(ms)
}

#[napi]
pub fn sp_greeting(ms: f64) -> String {
    dominio::dates::sp_greeting(ms).to_owned()
}

#[napi]
pub fn format_sp_full_date(ms: f64) -> String {
    dominio::dates::format_sp_full_date(ms)
}

#[napi]
pub fn sp_start_of_today_utc(now_ms: f64) -> f64 {
    dominio::dates::sp_start_of_today_utc(now_ms)
}

#[napi]
pub fn sp_week_key(ms: f64) -> String {
    dominio::dates::sp_week_key(ms)
}

#[napi]
pub fn sp_relative(date_ms: f64, now_ms: f64) -> String {
    dominio::dates::sp_relative(date_ms, now_ms)
}

#[napi]
pub fn sp_to_utc(year: f64, month: f64, day: f64, hour: f64, minute: f64) -> f64 {
    dominio::dates::sp_to_utc(year, month, day, hour, minute)
}

/// `null` sem valor.
#[napi]
pub fn format_duration_minutes(minutes: Option<f64>) -> String {
    dominio::dates::format_duration_minutes(minutes)
}

#[napi]
pub fn shift_day_key(day_key: String, days: f64) -> Result<String> {
    dominio::dates::shift_day_key(&day_key, days).map_err(date_error)
}

#[napi]
pub fn parse_sp_date_time_input(date_text: String, time_text: String) -> Option<f64> {
    dominio::dates::parse_sp_date_time_input(&date_text, &time_text)
}

/// Ver `src/domain/money.ts`.
fn money_error(error: dominio::money::MoneyError) -> Error {
    Error::from_reason(error.0)
}

#[napi]
pub fn sum_money_decimal(values: Vec<f64>, decimals: f64) -> Result<f64> {
    dominio::money::sum_money_decimal(&values, decimals).map_err(money_error)
}

#[napi]
pub fn sum_money_by(values: Vec<f64>, decimals: f64) -> Result<f64> {
    dominio::money::sum_money_by(&values, decimals).map_err(money_error)
}

#[napi]
pub fn round_money(value: f64, decimals: f64) -> Result<f64> {
    dominio::money::round_money(value, decimals).map_err(money_error)
}

#[napi]
pub fn multiply_money_decimal(
    value: f64,
    multiplier: f64,
    decimals: f64,
    multiplier_decimals: f64,
    divisor: f64,
    divisor_decimals: f64,
    result_decimals: f64,
) -> Result<f64> {
    let options = dominio::money::MultiplyOptions {
        decimals,
        multiplier_decimals,
        divisor,
        divisor_decimals,
        result_decimals,
    };
    dominio::money::multiply_money_decimal(value, multiplier, options).map_err(money_error)
}

#[napi]
pub fn money_by_percent(value: f64, percent: f64) -> Result<f64> {
    dominio::money::money_by_percent(value, percent).map_err(money_error)
}

#[napi]
pub fn units_to_brl(units: f64, valor_unidade: f64) -> Result<f64> {
    dominio::money::units_to_brl(units, valor_unidade).map_err(money_error)
}

#[napi]
pub fn units_to_reais(units: f64, unit_value: f64) -> Result<f64> {
    dominio::money::units_to_reais(units, unit_value).map_err(money_error)
}

#[napi]
pub fn kahan_sum(values: Vec<f64>) -> Result<f64> {
    dominio::money::kahan_sum(&values).map_err(money_error)
}

/// Inteiros em texto decimal: o BigInt do JavaScript atravessa como `toString()`.
#[napi]
pub fn divide_round_half_away(value: String, divisor: String) -> Result<String> {
    dominio::money::divide_round_half_away_text(&value, &divisor).map_err(money_error)
}

#[napi(js_name = "MoneyAccumulator")]
pub struct MoneyAccumulator {
    inner: dominio::money::MoneyAccumulator,
}

#[napi]
impl MoneyAccumulator {
    #[napi(constructor)]
    pub fn new(decimals: f64) -> Result<Self> {
        dominio::money::MoneyAccumulator::new(decimals)
            .map(|inner| Self { inner })
            .map_err(money_error)
    }

    #[napi]
    pub fn add(&mut self, value: f64) -> Result<f64> {
        self.inner.add(value).map_err(money_error)
    }

    #[napi(getter)]
    pub fn value(&self) -> Result<f64> {
        self.inner.value().map_err(money_error)
    }
}

/// `[instante em ms, só a data]`; `null` sem data no texto. A referência
/// inválida dá o erro do `utcToSpParts` só quando é usada, como no TS.
#[napi]
pub fn parse_br_kickoff(text: String, ref_ms: f64) -> Result<Option<(f64, bool)>> {
    dominio::kickoff::parse_br_kickoff(&text, ref_ms)
        .map(|parsed| parsed.map(|parsed| (parsed.ms, parsed.date_only)))
        .map_err(|error| Error::from_reason(error.0))
}

#[napi]
pub fn normalize_str(text: String) -> String {
    dominio::text_normalization::normalize_str(&text)
}

#[napi]
pub fn canonicalize_team_name(text: String) -> String {
    dominio::text_normalization::canonicalize_team_name(&text)
}

#[napi]
pub fn is_protected_token(token: String) -> bool {
    dominio::text_normalization::is_protected_token(&token)
}

#[napi]
pub fn team_name_variants(canon: String) -> Vec<String> {
    dominio::text_normalization::team_name_variants(&canon)
}

/// As palavras de parada dos nomes de time, carregadas uma vez pela casca.
#[napi]
pub fn team_stop_words() -> Vec<String> {
    dominio::text_normalization::TEAM_STOP_WORDS
        .iter()
        .map(|word| (*word).to_owned())
        .collect()
}

#[napi]
pub fn team_name_equivalents() -> Vec<Vec<String>> {
    dominio::text_normalization::TEAM_NAME_EQUIVALENTS
        .iter()
        .map(|row| row.iter().map(|form| (*form).to_owned()).collect())
        .collect()
}

#[napi]
pub fn regex_catalog() -> Vec<Vec<String>> {
    crate::regex_probe::catalog()
}

/// Intervalos UTF-16 `[início, fim]` de cada grupo (-1 no que não participou),
/// como `exec` com `lastIndex = from`; `null` sem casamento.
#[napi]
pub fn regex_exec(
    source: String,
    flags: String,
    text: String,
    from: u32,
) -> Result<Option<Vec<i64>>> {
    crate::regex_probe::exec(&source, &flags, &text, from).map_err(Error::from_reason)
}

#[napi]
pub fn regex_replace(
    source: String,
    flags: String,
    text: String,
    replacement: String,
) -> Result<String> {
    crate::regex_probe::replace(&source, &flags, &text, &replacement).map_err(Error::from_reason)
}

#[napi]
pub fn regex_split(
    source: String,
    flags: String,
    text: String,
    limit: Option<u32>,
) -> Result<Vec<String>> {
    crate::regex_probe::split(&source, &flags, &text, limit).map_err(Error::from_reason)
}

// --- team-category.ts e text.ts ---

use dominio::team_category as category;
use dominio::text as names;

#[napi]
pub fn team_category_tokens(canon: String, digits_only: bool) -> Vec<String> {
    category::team_category_tokens(&canon, digits_only)
}

#[napi]
pub fn reserve_suffix_mismatch(ca: String, cb: String) -> bool {
    category::reserve_suffix_mismatch(&ca, &cb)
}

#[napi]
pub fn has_protected_team_category_conflict(a: String, b: String) -> bool {
    category::has_protected_team_category_conflict(&a, &b)
}

#[napi]
pub fn team_identity_category_conflict(a: String, b: String) -> bool {
    category::team_identity_category_conflict(&a, &b)
}

#[napi]
pub fn bet_declares_category_fixture_lacks(canon_aposta: String, canon_fixture: String) -> bool {
    category::bet_declares_category_fixture_lacks(&canon_aposta, &canon_fixture)
}

#[napi]
pub fn category_tokens_from_league(league: String) -> Vec<String> {
    category::category_tokens_from_league(&league)
}

#[napi]
pub fn league_covers_bet_category(
    canon_aposta: String,
    canon_fixture: String,
    league: Option<String>,
) -> bool {
    category::league_covers_bet_category(&canon_aposta, &canon_fixture, league.as_deref())
}

#[napi]
pub fn oriented_team_pair_has_reserve_suffix_conflict(
    provider_home: String,
    provider_away: String,
    local_home: String,
    local_away: String,
    swapped: bool,
    league: Option<String>,
) -> bool {
    category::oriented_team_pair_has_reserve_suffix_conflict(&category::OrientedPair {
        provider_home: &provider_home,
        provider_away: &provider_away,
        local_home: &local_home,
        local_away: &local_away,
        swapped,
        league: league.as_deref(),
    })
}

#[napi]
pub fn strip_category_tokens(canon_name: String, tokens: Vec<String>) -> String {
    category::strip_category_tokens(&canon_name, &tokens)
}

/// `[compatível, tokens cobertos]`.
#[napi]
pub fn are_categories_compatible(
    bet_canon: String,
    fixture_canon: String,
    bet_league: Option<String>,
    fixture_league: Option<String>,
) -> (bool, Vec<String>) {
    let result = category::are_categories_compatible(
        &bet_canon,
        &fixture_canon,
        bet_league.as_deref(),
        fixture_league.as_deref(),
    );
    (result.compatible, result.covered_tokens)
}

#[napi]
pub fn team_category_conflict_in_context(
    bet_name: String,
    fixture_name: String,
    bet_league: Option<String>,
    fixture_league: Option<String>,
) -> bool {
    category::team_category_conflict_in_context(
        &bet_name,
        &fixture_name,
        bet_league.as_deref(),
        fixture_league.as_deref(),
    )
}

#[napi]
pub fn team_category_in_context(name: String, league: Option<String>) -> Vec<String> {
    category::team_category_in_context(&name, league.as_deref())
}

#[napi]
pub fn same_team_category(a: Vec<String>, b: Vec<String>) -> bool {
    category::same_team_category(&a, &b)
}

#[napi]
pub fn is_base_category_fixture(home: String, away: String, league: Option<String>) -> bool {
    category::is_base_category_fixture(&home, &away, league.as_deref())
}

#[napi]
pub fn team_similarity(a: String, b: String) -> f64 {
    names::team_similarity(&a, &b)
}

#[napi]
pub fn team_similarity_canon(ca: String, cb: String) -> f64 {
    names::team_similarity_canon(&ca, &cb)
}

/// `[score, evidence]`.
#[napi]
pub fn team_side_similarity_canon(ca: String, cb: String) -> (f64, f64) {
    let side = names::team_side_similarity_canon(&ca, &cb);
    (side.score, side.evidence)
}

#[napi]
pub fn team_name_evidence(a: String, b: String) -> f64 {
    names::team_name_evidence(&a, &b)
}

#[napi]
pub fn fixture_has_anchor_side(home_evidence: f64, away_evidence: f64) -> bool {
    names::fixture_has_anchor_side(home_evidence, away_evidence)
}

#[napi]
pub fn anchor_side_floor() -> f64 {
    names::ANCHOR_SIDE_FLOOR
}

#[napi]
pub fn best_search_word(text: String) -> String {
    names::best_search_word(&text)
}

/// `[casa, fora]`; `null` quando não é um confronto.
#[napi]
pub fn split_evento_teams(evento: String) -> Option<(String, String)> {
    names::split_evento_teams(&evento)
}

#[napi]
pub fn fixture_has_placeholder_team(evento: String) -> bool {
    names::fixture_has_placeholder_team(&evento)
}

#[napi]
pub fn same_fixture_teams(evento_a: String, evento_b: String) -> bool {
    names::same_fixture_teams(&evento_a, &evento_b)
}

#[napi]
pub fn slugify(text: String) -> String {
    names::slugify(&text)
}

fn match_numbers(result: names::MatchTeamsResult) -> Vec<f64> {
    let flag = |value: bool| if value { 1.0 } else { 0.0 };
    vec![
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
}

/// Os 12 campos de `MatchTeamsResult`, na ordem do tipo (booleanos como 0/1).
#[napi]
pub fn match_teams_with_category_context(
    bet_home: String,
    bet_away: String,
    fixture_home: String,
    fixture_away: String,
    bet_league: Option<String>,
    fixture_league: Option<String>,
    canonical: bool,
) -> Vec<f64> {
    let pair = names::CanonFixturePair {
        bet_home: &bet_home,
        bet_away: &bet_away,
        fixture_home: &fixture_home,
        fixture_away: &fixture_away,
        bet_league: bet_league.as_deref(),
        fixture_league: fixture_league.as_deref(),
    };
    match_numbers(if canonical {
        names::match_canon_teams_with_category_context(&pair)
    } else {
        names::match_teams_with_category_context(&pair)
    })
}

/// Os índices dos candidatos que ficam; os candidatos vêm em colunas.
#[napi]
#[allow(clippy::too_many_arguments)]
pub fn refine_category_candidates(
    bet_home: String,
    bet_away: String,
    bet_league: Option<String>,
    bet_kickoff_ms: Option<f64>,
    collapse_duplicate_listings: bool,
    homes: Vec<String>,
    aways: Vec<String>,
    leagues: Vec<String>,
    countries: Vec<String>,
    kickoffs: Vec<f64>,
    swapped: Vec<u32>,
) -> Vec<u32> {
    crate::refine_candidates(
        &names::CategoryRefinement {
            bet_home: &bet_home,
            bet_away: &bet_away,
            bet_league: bet_league.as_deref(),
            bet_kickoff_ms,
            collapse_duplicate_listings,
        },
        [homes, aways, leagues, countries],
        &kickoffs,
        &swapped,
    )
}

/// `[evento, selecao]` marcados; `null` quando nada muda.
#[napi]
pub fn mark_soccer_reserve_teams(evento: String, selecao: String) -> Option<(String, String)> {
    names::mark_soccer_reserve_teams(&evento, &selecao)
}
