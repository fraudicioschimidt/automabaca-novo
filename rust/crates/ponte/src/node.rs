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

// --- mercados/ ---

use dominio::mercados::{accents, match_scope, total_direction, trailing_side};

#[napi]
pub fn accentuate(term: String) -> String {
    accents::accentuate(&term)
}

#[napi]
pub fn accent_variants(term: String) -> Vec<String> {
    accents::accent_variants(&term)
}

/// `[MATCH_SCOPE_NOUNS, SIDE_SCOPE_NOUNS]`.
#[napi]
pub fn scope_nouns() -> Vec<Vec<String>> {
    let list = |nouns: &[&str]| nouns.iter().map(|noun| (*noun).to_owned()).collect();
    vec![
        list(&match_scope::MATCH_SCOPE_NOUNS),
        list(&match_scope::SIDE_SCOPE_NOUNS),
    ]
}

#[napi]
pub fn trailing_team_candidate(trailing: String) -> Option<String> {
    trailing_side::trailing_team_candidate(&trailing)
}

#[napi]
pub fn separate_compact_stat_unit(text: String) -> String {
    total_direction::separate_compact_stat_unit(&text)
}

#[napi]
pub fn expand_abbreviated_direction(selection: String) -> String {
    total_direction::expand_abbreviated_direction(&selection)
}

/// `[OVER_WORDS, UNDER_WORDS]`: as palavras de direção como alternância de regex.
#[napi]
pub fn total_direction_words() -> Vec<String> {
    vec![
        total_direction::OVER_WORDS.to_owned(),
        total_direction::UNDER_WORDS.to_owned(),
    ]
}

/// `"over"`, `"under"` ou `null`.
#[napi]
pub fn total_direction_of(selection: String, allow_bare_positive_line: bool) -> Option<String> {
    total_direction::total_direction_of(&selection, allow_bare_positive_line).map(|direction| {
        match direction {
            total_direction::TotalDirection::Over => "over".to_owned(),
            total_direction::TotalDirection::Under => "under".to_owned(),
        }
    })
}

use dominio::mercados::{catalog, draw_vocabulary};

fn owned(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

#[napi]
pub fn mercados_intermediarios() -> Vec<String> {
    owned(catalog::MERCADOS_INTERMEDIARIOS)
}

/// As traduções diretas PT/legado, na ordem do catálogo.
#[napi]
pub fn mercado_translations() -> Vec<(String, String)> {
    catalog::MERCADO_TRANSLATIONS
        .iter()
        .map(|(from, to)| ((*from).to_owned(), (*to).to_owned()))
        .collect()
}

#[napi]
pub fn normalize_mercado_key(text: String) -> String {
    catalog::normalize_mercado_key(&text)
}

#[napi]
pub fn resolve_mercado_canonical(raw: String) -> Option<String> {
    catalog::resolve_mercado_canonical(&raw).map(str::to_owned)
}

#[napi]
pub fn resolve_mercado_static(raw: String) -> Option<String> {
    catalog::resolve_mercado_static(&raw).map(str::to_owned)
}

#[napi]
pub fn is_mercado_final(mercado: String) -> bool {
    catalog::is_mercado_final(&mercado)
}

/// As listas de `DRAW_NO_BET_VOCABULARY` e depois as de
/// `DOUBLE_CHANCE_VOCABULARY`, na ordem dos campos.
#[napi]
pub fn draw_vocabulary() -> Vec<Vec<String>> {
    let dnb = &draw_vocabulary::DRAW_NO_BET_VOCABULARY;
    let dc = &draw_vocabulary::DOUBLE_CHANCE_VOCABULARY;
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
    .map(owned)
    .collect()
}

/// O time limpo, ou `null` quando a seleção não é DNB.
#[napi]
pub fn strip_draw_no_bet_from_selection(selecao: String) -> Option<String> {
    draw_vocabulary::strip_draw_no_bet_from_selection(&selecao)
}

/// O time limpo, ou `null` quando a seleção não é Dupla Chance.
#[napi]
pub fn strip_double_chance_from_selection(selecao: String) -> Option<String> {
    draw_vocabulary::strip_double_chance_from_selection(&selecao)
}

#[napi]
pub fn draw_no_bet_sql_terms() -> Vec<Vec<String>> {
    draw_vocabulary::draw_no_bet_sql_terms()
}

#[napi]
pub fn double_chance_sql_terms() -> Vec<Vec<String>> {
    draw_vocabulary::double_chance_sql_terms()
}

use dominio::mercados::stat_qualifier;

#[napi]
pub fn non_score_stat_terms() -> &'static str {
    stat_qualifier::NON_SCORE_STAT_TERMS
}

/// `[terms, sports]` de gols, corridas e pontos, nessa ordem.
#[napi]
pub fn score_unit_rules() -> Vec<(Vec<String>, Vec<String>)> {
    stat_qualifier::SCORE_UNIT_RULES
        .iter()
        .map(|rule| {
            let terms = rule.terms.iter().map(|term| (*term).to_owned()).collect();
            (terms, rule.sports.clone())
        })
        .collect()
}

#[napi]
pub fn is_both_teams_cards_text(text: String) -> bool {
    stat_qualifier::is_both_teams_cards_text(&text)
}

#[napi]
pub fn selecao_declara_linha_de_estatistica(selecao: String) -> bool {
    stat_qualifier::selecao_declara_linha_de_estatistica(&selecao)
}

#[napi]
pub fn has_non_score_stat_qualifier(mercado: String, selecao: String) -> bool {
    stat_qualifier::has_non_score_stat_qualifier(&mercado, &selecao)
}

#[napi]
pub fn has_unknown_score_qualifier(mercado: String) -> bool {
    stat_qualifier::has_unknown_score_qualifier(&mercado)
}

#[napi]
pub fn known_score_qualifier_sql_terms() -> Vec<String> {
    stat_qualifier::known_score_qualifier_sql_terms()
}

#[napi]
pub fn non_score_stat_sql_terms() -> Vec<String> {
    stat_qualifier::non_score_stat_sql_terms()
}

#[napi]
pub fn score_unit_terms_for_sql() -> Vec<String> {
    stat_qualifier::score_unit_terms_for_sql()
}

#[napi]
pub fn has_score_unit_mismatch(mercado: String, selecao: String, esporte: Option<String>) -> bool {
    stat_qualifier::has_score_unit_mismatch(&mercado, &selecao, esporte.as_deref())
}

#[napi]
pub fn has_sport_score_unit_mismatch(
    mercado: String,
    selecao: String,
    esporte: Option<String>,
) -> bool {
    stat_qualifier::has_sport_score_unit_mismatch(&mercado, &selecao, esporte.as_deref())
}

// --- sports/ ---

use dominio::sports::{detect, registry};

/// `[sport, status, confidence, source, ...evidência em colunas]`.
type DecisionColumns = (
    Option<String>,
    String,
    f64,
    String,
    Vec<String>,
    Vec<String>,
    Vec<f64>,
    Vec<String>,
);

fn decision_columns(decision: detect::Decision) -> DecisionColumns {
    let evidence = &decision.evidence;
    (
        decision.sport.map(str::to_owned),
        decision.status.as_str().to_owned(),
        decision.confidence,
        decision.source.as_str().to_owned(),
        evidence
            .iter()
            .map(|item| item.source.as_str().to_owned())
            .collect(),
        evidence.iter().map(|item| item.sport.to_owned()).collect(),
        evidence.iter().map(|item| item.confidence).collect(),
        evidence.iter().map(|item| item.value.clone()).collect(),
    )
}

#[napi]
pub fn canonical_sport(value: Option<String>) -> Option<String> {
    registry::canonical_sport(value.as_deref().unwrap_or("")).map(str::to_owned)
}

#[napi]
pub fn esportes_com_unidade(unidade: String) -> Vec<String> {
    registry::UnidadeDoPlacar::parse(&unidade).map_or_else(Vec::new, registry::esportes_com_unidade)
}

#[napi]
pub fn termos_de_unidade_sem_placar() -> Vec<String> {
    owned(&registry::termos_de_unidade_sem_placar())
}

/// `[SPORT_RESOLVER_VERSION, AUTO_CONFIRM, DISSENT, SHARED_SOCCER_LEAGUE]`.
#[napi]
pub fn sport_detection_constants() -> (u32, f64, f64, String) {
    (
        detect::SPORT_RESOLVER_VERSION,
        detect::SPORT_AUTO_CONFIRM_MIN_CONFIDENCE,
        detect::SPORT_DISSENT_MIN_CONFIDENCE,
        detect::SHARED_SOCCER_LEAGUE.to_owned(),
    )
}

#[napi]
pub fn detect_sport_from_text(text: String, item_sport: Option<String>) -> DecisionColumns {
    decision_columns(detect::detect_sport_from_text(&text, item_sport.as_deref()))
}

#[napi]
pub fn llm_sport_decision(
    sport: Option<String>,
    confidence: Option<f64>,
    evidence_text: Option<String>,
) -> DecisionColumns {
    decision_columns(detect::llm_sport_decision(
        sport.as_deref(),
        confidence,
        evidence_text.as_deref(),
    ))
}

// --- countries e national-teams ---

use dominio::{countries, national_teams};

fn owned_pairs(table: &[(&str, &str)]) -> Pairs {
    table
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect()
}

type Pairs = Vec<(String, String)>;

/// `[NATIONAL_TEAMS_PT_EN, CANONICAL_COUNTRY_MAP, KNOWN_COUNTRY_KEYS]`.
#[napi]
pub fn country_tables() -> (Pairs, Pairs, Vec<String>) {
    (
        owned_pairs(countries::NATIONAL_TEAMS_PT_EN),
        owned_pairs(countries::CANONICAL_COUNTRY_MAP),
        countries::KNOWN_COUNTRY_KEYS.clone(),
    )
}

#[napi]
pub fn translate_national_team_pt_to_en(local_name: String) -> Option<String> {
    national_teams::translate_national_team_pt_to_en(&local_name).map(str::to_owned)
}

#[napi]
pub fn canonical_country(raw: String) -> String {
    national_teams::canonical_country(&raw)
}

#[napi]
pub fn canonical_competition(raw: String, pais: Option<String>) -> String {
    national_teams::canonical_competition(&raw, pais.as_deref())
}

#[napi]
pub fn rewrite_national_teams_in_text(text: String, event_teams: Option<Vec<String>>) -> String {
    let teams: Option<Vec<&str>> = event_teams
        .as_ref()
        .map(|teams| teams.iter().map(String::as_str).collect());
    national_teams::rewrite_national_teams_in_text(&text, teams.as_deref())
}

#[napi]
pub fn rewrite_selecao_with_matched_teams(
    selecao: String,
    local_home: String,
    local_away: String,
    pinnacle_home: String,
    pinnacle_away: String,
) -> String {
    national_teams::rewrite_selecao_with_matched_teams(
        &selecao,
        &local_home,
        &local_away,
        &pinnacle_home,
        &pinnacle_away,
    )
}

// --- settlement/ ---

use dominio::settlement::sides::{self, Outcome, Side};

fn side_name(side: Option<Side>) -> Option<&'static str> {
    side.map(Side::as_str)
}

#[napi]
pub fn strip_team_names(selecao: String, evento: String) -> String {
    sides::strip_team_names(&selecao, &evento)
}

#[napi]
pub fn match_team_side(selecao: String, evento: String) -> Option<&'static str> {
    side_name(sides::match_team_side(&selecao, &evento))
}

#[napi]
pub fn match_moneyline_selection(
    selecao: String,
    evento: String,
    strict: bool,
) -> Option<&'static str> {
    sides::match_moneyline_selection(&selecao, &evento, strict).map(Outcome::as_str)
}

/// `[side, contradicts]`.
#[napi]
pub fn resolve_side_from_market_and_selection(
    mercado: String,
    selecao: String,
    evento: String,
) -> (Option<&'static str>, bool) {
    let (side, contradicts) =
        sides::resolve_side_from_market_and_selection(&mercado, &selecao, &evento);
    (side_name(side), contradicts)
}

#[napi]
pub fn match_draw_no_bet_selection(selecao: String, evento: String) -> Option<&'static str> {
    side_name(sides::match_draw_no_bet_selection(&selecao, &evento))
}

#[napi]
pub fn match_double_chance_selection(selecao: String, evento: String) -> Option<Vec<&'static str>> {
    sides::match_double_chance_selection(&selecao, &evento)
        .map(|(one, other)| vec![one.as_str(), other.as_str()])
}

use dominio::mercados::classify;

/// `[EXTRA_TIME_PATTERN, REGULATION_TIME_PATTERN]` (fontes) e as listas:
/// `[escopos de outright, frases de vencedor, 1º tempo, 2º tempo, siglas do 1º, siglas do 2º]`.
#[napi]
pub fn classify_data() -> (Vec<String>, Vec<Vec<String>>) {
    (
        owned(&[
            classify::EXTRA_TIME_PATTERN,
            classify::REGULATION_TIME_PATTERN,
        ]),
        vec![
            owned(classify::OUTRIGHT_SCOPE_NOUNS),
            owned(classify::OUTRIGHT_WINNER_PHRASES),
            owned(classify::HALF_PERIOD_PHRASES_FIRST),
            owned(classify::HALF_PERIOD_PHRASES_SECOND),
            owned(classify::HALF_PERIOD_ABBREVIATIONS_FIRST),
            owned(classify::HALF_PERIOD_ABBREVIATIONS_SECOND),
        ],
    )
}

#[napi]
pub fn is_esports(esporte: Option<String>) -> bool {
    classify::is_esports(esporte.as_deref())
}

#[napi]
pub fn market_map_number_of(mercado: String, esporte: Option<String>) -> Option<u32> {
    classify::market_map_number_of(&mercado, esporte.as_deref())
}

#[napi]
pub fn market_includes_extra_time(mercado: String) -> bool {
    classify::market_includes_extra_time(&mercado)
}

#[napi]
pub fn declares_regulation_time(text: String) -> bool {
    classify::declares_regulation_time(&text)
}

#[napi]
pub fn is_btts_market(mercado: String) -> bool {
    classify::is_btts_market(&mercado)
}

#[napi]
pub fn is_combined_btts_market(mercado: String) -> bool {
    classify::is_combined_btts_market(&mercado)
}

#[napi]
pub fn btts_selection_side(selecao: String) -> Option<&'static str> {
    classify::btts_selection_side(&selecao).map(classify::BttsSide::as_str)
}

#[napi]
pub fn is_race_to_market(mercado: String, selecao: String) -> bool {
    classify::is_race_to_market(&mercado, &selecao)
}

#[napi]
pub fn is_three_way_handicap_market(mercado: String) -> bool {
    classify::is_three_way_handicap_market(&mercado)
}

#[napi]
pub fn is_outright_market(mercado: String) -> bool {
    classify::is_outright_market(&mercado)
}

#[napi]
pub fn is_method_of_victory_market(mercado: String) -> bool {
    classify::is_method_of_victory_market(&mercado)
}

#[napi]
pub fn is_draw_no_bet_market(mercado: String) -> bool {
    classify::is_draw_no_bet_market(&mercado)
}

#[napi]
pub fn is_double_chance_market(mercado: String) -> bool {
    classify::is_double_chance_market(&mercado)
}

#[napi]
pub fn total_label_side(mercado: String, evento: String) -> Option<&'static str> {
    side_name(classify::total_label_side(&mercado, &evento))
}

#[napi]
pub fn market_period_of(mercado: String, esporte: Option<String>) -> &'static str {
    classify::market_period_of(&mercado, esporte.as_deref()).as_str()
}

#[napi]
pub fn market_kind_of(mercado: String, selecao: String, evento: Option<String>) -> &'static str {
    classify::market_kind_of(&mercado, &selecao, evento.as_deref()).as_str()
}

use dominio::mercados::{compatibility, finalize};

/// Cada rótulo final com os esportes em que ele vale.
type FinalMarketSports = Vec<(String, Vec<String>)>;

/// `[[rótulo final, esportes][], [regulamentar: moneyline, spread, total], esportes com prorrogação]`.
#[napi]
pub fn compatibility_data() -> (FinalMarketSports, Vec<String>, Vec<String>) {
    let sports = |list: &[compatibility::MarketSport]| {
        list.iter().map(|sport| sport.as_str().to_owned()).collect()
    };
    (
        compatibility::FINAL_MARKET_SPORTS
            .iter()
            .map(|(market, list)| ((*market).to_owned(), sports(list)))
            .collect(),
        owned(&[
            compatibility::REGULATION_TIME_MONEYLINE,
            compatibility::REGULATION_TIME_SPREAD,
            compatibility::REGULATION_TIME_TOTAL,
        ]),
        sports(compatibility::REGULATION_TIME_SPORTS),
    )
}

#[napi]
pub fn market_sport_of(esporte: Option<String>) -> &'static str {
    compatibility::market_sport_of(esporte.as_deref()).as_str()
}

#[napi]
pub fn restricts_to_regulation_time(text: String, esporte: Option<String>) -> bool {
    compatibility::restricts_to_regulation_time(&text, esporte.as_deref())
}

#[napi]
pub fn regulation_time_base_of(mercado: String) -> Option<&'static str> {
    compatibility::regulation_time_base_of(&mercado)
}

#[napi]
pub fn is_regulation_time_market(mercado: String) -> bool {
    compatibility::is_regulation_time_market(&mercado)
}

#[napi]
pub fn is_mercado_final_for_sport(mercado: String, esporte: Option<String>) -> bool {
    compatibility::is_mercado_final_for_sport(&mercado, esporte.as_deref())
}

#[napi]
pub fn finalize_pinnacle_market(mercado: String, esporte: Option<String>) -> String {
    finalize::finalize_pinnacle_market(&mercado, esporte.as_deref())
}

#[napi]
pub fn regulation_time_market(
    mercado: String,
    selecao: String,
    evento: String,
    esporte: Option<String>,
    declared: bool,
) -> String {
    finalize::regulation_time_market(&mercado, &selecao, &evento, esporte.as_deref(), declared)
}

#[napi]
pub fn pinnacleize_mercado(mercado: String, esporte: Option<String>) -> String {
    finalize::pinnacleize_mercado(&mercado, esporte.as_deref())
}

#[napi]
pub fn keep_declared_period(
    original: String,
    coerced: String,
    esporte: Option<String>,
    selecao: String,
) -> String {
    finalize::keep_declared_period(&original, &coerced, esporte.as_deref(), &selecao)
}

use dominio::mercados::{double_chance_selection, sharp_equivalent};

/// `[mercado, selecao]` canônicos, ou `null` quando não é Dupla Chance.
#[napi]
pub fn canonical_double_chance_selection(
    evento: String,
    mercado: String,
    selecao: String,
    esporte: String,
) -> Option<Vec<String>> {
    double_chance_selection::canonical_double_chance_selection(
        &evento, &mercado, &selecao, &esporte,
    )
    .map(|(mercado, selecao)| vec![mercado, selecao])
}

#[napi]
pub fn supports_sharp_equivalence(esporte: Option<String>) -> bool {
    sharp_equivalent::supports_sharp_equivalence(esporte.as_deref())
}

/// `[mercado, selecao, nota]`, ou `null` sem equivalente.
#[napi]
pub fn sharp_equivalent_bet(
    mercado: String,
    selecao: String,
    evento: String,
    esporte: Option<String>,
) -> Option<Vec<String>> {
    sharp_equivalent::sharp_equivalent_bet(&mercado, &selecao, &evento, esporte.as_deref())
        .map(|bet| vec![bet.mercado.to_owned(), bet.selecao, bet.nota.to_owned()])
}

use dominio::settlement::lines;

#[napi]
pub fn unknown_line_separator() -> &'static str {
    lines::UNKNOWN_LINE_SEPARATOR
}

#[napi]
pub fn line_to_quarters(line: f64) -> Option<f64> {
    lines::line_to_quarters(line)
}

#[napi]
pub fn without_numbered_half(text: String) -> String {
    lines::without_numbered_half(&text)
}

#[napi]
pub fn extract_signed_numbers(text: String) -> Vec<f64> {
    lines::extract_signed_numbers(&text)
}

#[napi]
pub fn parse_line_quarters(selecao: String, allow_negative: bool) -> Option<f64> {
    lines::parse_line_quarters(&selecao, allow_negative)
}

#[napi]
pub fn status_from_adjusted_quarters(adjusted: f64) -> &'static str {
    lines::status_from_adjusted_quarters(adjusted)
}

use dominio::bookmaker;
use dominio::settlement::goalscorer_matching as scorer;

#[napi]
pub fn canonicalize_bookmaker_name(value: String) -> String {
    bookmaker::canonicalize_bookmaker_name(&value)
}

/// `[similaridade mínima, vantagem mínima]`.
#[napi]
pub fn goalscorer_thresholds() -> Vec<f64> {
    vec![
        scorer::GOALSCORER_MIN_SIMILARIDADE,
        scorer::GOALSCORER_MIN_VANTAGEM,
    ]
}

#[napi]
pub fn tokens_do_nome(nome: String) -> Vec<String> {
    scorer::tokens_do_nome(&nome)
}

#[napi]
pub fn similaridade_de_tokens(ta: Vec<String>, tb: Vec<String>) -> f64 {
    scorer::similaridade_de_tokens(&ta, &tb)
}

#[napi]
pub fn tokens_da_selecao(selecao: String) -> Vec<String> {
    scorer::tokens_da_selecao(&selecao)
}

#[napi]
pub fn tem_polaridade_negativa(textos: Vec<String>) -> bool {
    scorer::tem_polaridade_negativa(&textos)
}

#[napi]
pub fn player_match_refusals() -> Vec<&'static str> {
    scorer::PLAYER_MATCH_REFUSALS
        .iter()
        .map(|reason| reason.as_str())
        .collect()
}

/// `nomesCurtos[i]` vazio é o jogador sem abreviado.
#[napi]
pub fn encontrar_jogador_na_partida(
    selecao: String,
    nomes: Vec<String>,
    nomes_curtos: Vec<String>,
) -> Vec<f64> {
    let jogadores: Vec<scorer::NamedPlayer> = nomes
        .iter()
        .enumerate()
        .map(|(i, nome)| scorer::NamedPlayer {
            nome,
            nome_curto: nomes_curtos.get(i).map(String::as_str),
        })
        .collect();
    scorer::encontrar_jogador_na_partida(&selecao, &jogadores).encoded()
}

#[napi]
pub fn participation_unproven(minutos_publicados: bool, participou: bool, sem_gols: bool) -> bool {
    scorer::participation_unproven(minutos_publicados, participou, sem_gols)
}

#[napi]
pub fn listed_but_did_not_play(minutos: Option<f64>, participou: bool, sem_gols: bool) -> bool {
    scorer::listed_but_did_not_play(minutos, participou, sem_gols)
}

use dominio::settlement::over_under_subject as subject;

#[napi]
pub fn subject_after_line(selecao: String, evento: Option<String>) -> Option<String> {
    subject::subject_after_line(&selecao, evento.as_deref())
}

#[napi]
pub fn line_subject_is_not_event_team(selecao: String, evento: Option<String>) -> bool {
    subject::line_subject_is_not_event_team(&selecao, evento.as_deref())
}

use dominio::mercados::selection_shape as shape;

#[napi]
pub fn strip_selection_odds(selection: String) -> String {
    shape::strip_selection_odds(&selection)
}

#[napi]
pub fn is_esports_player_selection(selecao: String, evento: String) -> bool {
    shape::is_esports_player_selection(&selecao, &evento)
}

#[napi]
pub fn selection_total_line(selecao: String, evento: String) -> Option<f64> {
    shape::selection_total_line(&selecao, &evento)
}

#[napi]
pub fn selecao_parece_handicap(selecao: String) -> bool {
    shape::selecao_parece_handicap(&selecao)
}

#[napi]
pub fn selecao_nomeia_time_do_total(selecao: String, evento: String) -> bool {
    shape::selecao_nomeia_time_do_total(&selecao, &evento)
}

#[napi]
pub fn declares_european_handicap(selecao: String) -> bool {
    shape::declares_european_handicap(&selecao)
}

use dominio::settlement::markets;

#[napi]
pub fn classify_score_market(
    mercado_n: String,
    selecao_n: String,
    evento: Option<String>,
) -> Option<&'static str> {
    markets::classify_score_market(&mercado_n, &selecao_n, evento.as_deref())
        .map(|kind| kind.as_str())
}

#[napi]
pub fn is_score_resolvable_market(
    mercado: String,
    selecao: String,
    esporte: Option<String>,
    evento: Option<String>,
) -> bool {
    markets::is_score_resolvable_market(&mercado, &selecao, esporte.as_deref(), evento.as_deref())
}

#[napi]
pub fn declared_score_period(
    mercado: String,
    selecao: String,
    esporte: Option<String>,
) -> &'static str {
    markets::declared_score_period(&mercado, &selecao, esporte.as_deref()).as_str()
}

use dominio::settlement::goalscorer;

#[napi]
pub fn eh_mercado_artilheiro(mercado: String, selecao: Option<String>) -> bool {
    goalscorer::eh_mercado_artilheiro(&mercado, selecao.as_deref())
}

#[napi]
pub fn eh_mercado_artilheiro_por_tempo(mercado: String, selecao: Option<String>) -> bool {
    goalscorer::eh_mercado_artilheiro_por_tempo(&mercado, selecao.as_deref())
}

#[napi]
pub fn has_unsupported_goal_qualifier(mercado: String, selecao: String) -> bool {
    goalscorer::has_unsupported_goal_qualifier(&mercado, &selecao)
}

#[napi]
pub fn ordered_goalscorer_market_order(
    mercado: String,
    selecao: Option<String>,
) -> Option<&'static str> {
    goalscorer::ordered_goalscorer_market_order(&mercado, selecao.as_deref())
        .map(|order| order.as_str())
}

#[napi]
pub fn minuto_base(raw: String) -> Option<f64> {
    goalscorer::minuto_base(&raw)
}

#[napi]
pub fn required_player_goals(mercado: String, selecao: String) -> Option<f64> {
    goalscorer::required_player_goals(&mercado, &selecao)
}

use dominio::settlement::player_prop_classify as prop;

/// `[família, rótulo final, chave do FlashScore ("" em cards_any), chave gravada]`.
#[napi]
pub fn player_prop_families() -> Vec<Vec<&'static str>> {
    prop::FAMILIES
        .iter()
        .map(|row| vec![row.1, row.2, row.4.unwrap_or(""), row.0.chave()])
        .collect()
}

#[napi]
pub fn prop_stat_label(family: String, value: f64) -> String {
    prop::prop_stat_label(&family, value)
}

/// `[família, período ("" no jogo inteiro)]`, ou `null` quando não é prop.
#[napi]
pub fn classificar_prop_de_jogador(
    mercado: String,
    selecao: String,
    evento: Option<String>,
    esporte: Option<String>,
) -> Option<Vec<&'static str>> {
    prop::classificar_prop_de_jogador(&mercado, &selecao, evento.as_deref(), esporte.as_deref())
        .map(|found| {
            vec![
                found.family.as_str(),
                found.period.map_or("", |period| period.as_str()),
            ]
        })
}
