//! Lado apostado (casa, fora, empate) a partir da seleção e do evento,
//! portado de `src/domain/settlement/sides.ts`: tokens explícitos, nome do
//! time com margem mínima de similaridade, rótulos ordinais ("Time 1"),
//! moneyline, Draw No Bet e Dupla Chance. Empate técnico é ambíguo e devolve
//! `None`: nunca chuta, porque o lado errado inverte o lucro.

use crate::js;
use crate::mercados::draw_vocabulary::{double_chance_pattern, draw_no_bet_pattern};
use crate::mercados::match_scope::SIDE_SCOPE_NOUNS;
use crate::team_category::has_protected_team_category_conflict;
use crate::text::{split_evento_teams, team_similarity};
use crate::text_normalization::{canonicalize_team_name, collapse_whitespace, normalize_str};
use js_regex::{Regex, regex};
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Side {
    Home,
    Away,
}

/// O resultado de uma moneyline ou de uma alternativa de Dupla Chance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Outcome {
    Home,
    Away,
    Draw,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Home => "home",
            Side::Away => "away",
        }
    }
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Home => "home",
            Outcome::Away => "away",
            Outcome::Draw => "draw",
        }
    }
}

impl From<Side> for Outcome {
    fn from(side: Side) -> Outcome {
        match side {
            Side::Home => Outcome::Home,
            Side::Away => Outcome::Away,
        }
    }
}

fn compiled(source: &str, flags: &str) -> Regex {
    Regex::cataloged(source, flags)
        .unwrap_or_else(|error| panic!("regex inválida /{source}/{flags}: {error}"))
}

fn home_tokens() -> &'static Regex {
    regex!(r"\b(home|casa|mandante)\b", "")
}

fn away_tokens() -> &'static Regex {
    regex!(r"\b(away|fora|visitante)\b", "")
}

fn draw_tokens() -> &'static Regex {
    regex!(r"\b(draw|empate|tie)\b", "")
}

const DC_CONNECTIVE_WORDS: &str = "ou|or|e|y|and";
const DC_CONNECTIVE_SYMBOLS: &str = r"\/|\+|&";

static DRAW_ALTERNATIVE: LazyLock<Regex> = LazyLock::new(|| {
    compiled(
        &format!(r"(?:\b(?:{DC_CONNECTIVE_WORDS})\b|{DC_CONNECTIVE_SYMBOLS})"),
        "",
    )
});
static DC_SPLIT: LazyLock<Regex> = LazyLock::new(|| {
    compiled(
        &format!(r"\s*(?:\b(?:{DC_CONNECTIVE_WORDS})\b|{DC_CONNECTIVE_SYMBOLS}|\s+-\s+|,)\s*"),
        "i",
    )
});

fn draw_negated() -> &'static Regex {
    regex!(
        r"\b(?:no|nao|not|sem|against|contra|anti)\s+(?:draw|empate|tie)\b",
        ""
    )
}

static DNB_LABEL: LazyLock<String> = LazyLock::new(|| draw_no_bet_pattern(r"\s+"));
static DNB_ANY: LazyLock<Regex> = LazyLock::new(|| compiled(&format!(r"\b{}\b", *DNB_LABEL), ""));
static DNB_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| compiled(&format!(r"^\s*{}\s*[:\-]?\s*", *DNB_LABEL), ""));
static DNB_SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
    let label = &*DNB_LABEL;
    compiled(
        &format!(r"\s*(?:\(\s*{label}\s*\)|-\s*{label}|{label})\s*$"),
        "",
    )
});
static DOUBLE_CHANCE_LABEL: LazyLock<String> = LazyLock::new(|| double_chance_pattern(r"\s+"));
static DOUBLE_CHANCE_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| compiled(&format!(r"^{}\s*[:\-]?\s*", *DOUBLE_CHANCE_LABEL), ""));
static DOUBLE_CHANCE_SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
    let label = &*DOUBLE_CHANCE_LABEL;
    compiled(
        &format!(r"\s*(?:\(\s*{label}\s*\)|-\s*{label}|{label})\s*$"),
        "",
    )
});

static SIDE_SCOPE: LazyLock<String> = LazyLock::new(|| SIDE_SCOPE_NOUNS.join("|"));
static HOME_LABEL_SRC: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:time|equipe|clube|team|club)\s*1|primeiro\s+time|primeira\s+equipe|primeiro\s+clube|1[oaºª]\s*(?:time|equipe|clube)|first\s+(?:team|club)|1st\s+(?:team|club)|local\s+team|(?:vencedor|ganhador)(?:\s+d[oa]\s+(?:{}))?\s*1|(?:match|event)?\s*winner\s*1",
        *SIDE_SCOPE
    )
});
static AWAY_LABEL_SRC: LazyLock<String> = LazyLock::new(|| {
    format!(
        r"(?:time|equipe|clube|team|club)\s*2|segundo\s+time|segunda\s+equipe|segundo\s+clube|2[oaºª]\s*(?:time|equipe|clube)|second\s+(?:team|club)|2nd\s+(?:team|club)|visitor\s+team|visiting\s+team|(?:vencedor|ganhador)(?:\s+d[oa]\s+(?:{}))?\s*2|(?:match|event)?\s*winner\s*2",
        *SIDE_SCOPE
    )
});
static HOME_LABEL: LazyLock<Regex> =
    LazyLock::new(|| compiled(&format!("^(?:{})$", *HOME_LABEL_SRC), ""));
static AWAY_LABEL: LazyLock<Regex> =
    LazyLock::new(|| compiled(&format!("^(?:{})$", *AWAY_LABEL_SRC), ""));
static PARENTHETICAL_ANNOTATION: LazyLock<Regex> = LazyLock::new(|| {
    let inner = format!(
        r"(?:[+\-]?\s*\d+(?:[.,]\d+)?|{}|{})",
        *HOME_LABEL_SRC, *AWAY_LABEL_SRC
    );
    compiled(
        &format!(r"\s*(?:\(\s*{inner}\s*\)|\[\s*{inner}\s*\])\s*$"),
        "",
    )
});

/// Palavras de um texto separadas por espaço do JS: `split(/\s+/).filter(Boolean)`.
fn words(text: &str) -> impl Iterator<Item = &str> {
    text.split(js::is_whitespace)
        .filter(|word| !word.is_empty())
}

fn is_ascii_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// `\w` sem a flag `u`: só ASCII. Byte de caractere não ASCII nunca é palavra.
fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// `text.replace(/\btoken\b/g, " ")`, e para o token numérico a forma que não
/// apaga a linha: `(?<![+\-\d.,])\btoken\b(?![.,]\d)`. O token é ASCII
/// (`[a-z0-9]+`), então a busca é literal, sem montar regex por time.
fn remove_token(text: &str, token: &str, numeric: bool) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        let end = at + token.len();
        let found = text[at..].starts_with(token)
            && (at == 0 || !is_word_byte(bytes[at - 1]))
            && (end == bytes.len() || !is_word_byte(bytes[end]))
            && (!numeric
                || ((at == 0 || !b"+-0123456789.,".contains(&bytes[at - 1]))
                    && !(matches!(bytes.get(end), Some(b'.' | b','))
                        && bytes.get(end + 1).is_some_and(u8::is_ascii_digit))));
        if found {
            out.push_str(&text[copied..at]);
            out.push(' ');
            copied = end;
            at = end;
        } else {
            at += text[at..].chars().next().map_or(1, char::len_utf8);
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// Remove o NOME DO TIME da seleção antes de extrair a linha (o inverso de
/// `match_team_side`). Sem isto, dígitos do clube ("1. FC Köln", "Schalke 04")
/// vazam para a leitura da linha e a corrompem; o sinal é preservado, para o
/// "1" do nome não apagar o "+1" do handicap.
pub fn strip_team_names(selecao: &str, evento: &str) -> String {
    let normalized = normalize_str(selecao);
    let Some((home, away)) = split_evento_teams(evento) else {
        return normalized;
    };
    let mut out = normalized;
    for team in [&home, &away] {
        let team = normalize_str(team);
        let tokens: Vec<&str> = regex!(r"[a-z0-9]+", "g")
            .exec_all(&team)
            .into_iter()
            .filter_map(|found| found.get(0))
            .collect();
        for (index, token) in tokens.iter().enumerate() {
            let numeric = is_ascii_digits(token);
            // Em `Sub-20`/`U 20`, o 20 é a categoria do time, mas pode ser a
            // linha legítima de `Over 20`: apagar só esse número apagaria a
            // aposta inteira. `U20` já é um token alfanumérico.
            if numeric && index > 0 && matches!(tokens[index - 1], "sub" | "u" | "under") {
                continue;
            }
            out = remove_token(&out, token, numeric);
        }
    }
    out
}

const SIDE_MIN_SIMILARITY: f64 = 0.72;
const SIDE_MIN_MARGIN: f64 = 0.15;

const GENERIC_TEAM_SUBTOKENS: &[&str] = &[
    "f",
    "m",
    "fc",
    "sc",
    "ec",
    "ac",
    "cf",
    "fk",
    "sk",
    "bk",
    "cd",
    "ca",
    "club",
    "clube",
    "de",
    "da",
    "do",
    "das",
    "dos",
    "the",
    "team",
    "vs",
    "x",
    "e",
    "esporte",
    "deportivo",
    "atletico",
    "sporting",
    "real",
    "futebol",
    "women",
    "ladies",
    "fem",
    "feminino",
];

/// Sigla do estado e o adjetivo do clube ("Atlético-MG", "Atlético Mineiro").
const BRAZILIAN_STATE_SUFFIXES: [(&str, &str); 8] = [
    ("MG", "Mineiro"),
    ("PR", "Paranaense"),
    ("RJ", "Carioca"),
    ("RS", "Gaucho"),
    ("BA", "Baiano"),
    ("SP", "Paulista"),
    ("CE", "Cearense"),
    ("GO", "Goiano"),
];

/// "-MG"/" RJ" no fim do nome do clube; o grupo é a sigla do estado.
fn brazilian_state_suffix() -> &'static Regex {
    regex!(r"(?:-|\s)(MG|PR|RJ|RS|BA|SP|CE|GO)$", "i")
}

fn state_adjective(state: &str) -> &'static str {
    BRAZILIAN_STATE_SUFFIXES
        .iter()
        .find(|(sigla, _)| sigla.eq_ignore_ascii_case(state))
        .map_or("", |(_, adjective)| adjective)
}

/// Alias estadual restrito ao matching de LADO. Não entra na canonicalização
/// global porque o nome canônico é identidade persistida: mudar "Operário-PR"
/// para outra chave duplicaria clubes já conhecidos no banco.
fn expand_brazilian_club_suffix(team: &str) -> String {
    brazilian_state_suffix().replace_with(team, |found| {
        format!(" {}", state_adjective(found.get(1).unwrap_or("")))
    })
}

fn brazilian_state_identity(team: &str) -> Option<String> {
    if let Some(found) = brazilian_state_suffix().exec(team) {
        return found.get(1).map(str::to_ascii_uppercase);
    }
    let normalized = normalize_str(team);
    let last = words(&normalized).last()?;
    BRAZILIAN_STATE_SUFFIXES
        .iter()
        .find(|(_, adjective)| normalize_str(adjective) == last)
        .map(|(state, _)| (*state).to_owned())
}

fn strip_brazilian_club_suffix(team: &str) -> String {
    js::trim(&brazilian_state_suffix().replace(team, "")).to_owned()
}

fn team_side_similarity(selection: &str, team: &str) -> f64 {
    // América-MG e América-RJ, Atlético-GO e Atlético-MG são clubes
    // diferentes: a forma sem estado só entra sem conflito estadual explícito.
    if let (Some(selection_state), Some(team_state)) = (
        brazilian_state_identity(selection),
        brazilian_state_identity(team),
    ) && selection_state != team_state
    {
        return 0.0;
    }
    js::max(
        js::max(
            team_similarity(selection, team),
            team_similarity(
                &expand_brazilian_club_suffix(selection),
                &expand_brazilian_club_suffix(team),
            ),
        ),
        team_similarity(
            &strip_brazilian_club_suffix(selection),
            &strip_brazilian_club_suffix(team),
        ),
    )
}

/// A seleção traz a categoria (feminino, reserva, base) que o time do evento
/// não tem. "Ben Shelton Under 18" não escolhe um jogador sub-18: a linha sai
/// antes, salvo quando o token faz parte do nome do participante.
fn category_mismatch(selecao: &str, time: &str, other: &str) -> bool {
    let time_normalized = normalize_str(time);
    let category_selection = regex!(
        r"\b(?:over|under|mais|menos|acima|abaixo)\s+(?:de\s+)?\d+(?:[.,]\d+)?",
        "gi"
    )
    .replace_with(selecao, |found| {
        let token = found.get(0).unwrap_or("");
        if time_normalized.contains(&normalize_str(token)) {
            token.to_owned()
        } else {
            " ".to_owned()
        }
    });
    if !has_protected_team_category_conflict(&category_selection, time) {
        return false;
    }
    let canon = canonicalize_team_name(&category_selection);
    let selection_has_category = canon.split(' ').any(|token| {
        matches!(
            token,
            "women" | "feminino" | "ladies" | "fem" | "reserves" | "reservas" | "youth"
        ) || regex!(r"^u\d{2}$", "").is_match(token)
            || regex!(r"^sub\d{2}$", "").is_match(token)
    });
    let both_teams_share_category = !has_protected_team_category_conflict(time, other);
    selection_has_category || !both_teams_share_category
}

/// Lado apostado (casa/fora): tokens explícitos, depois nome do time com
/// MARGEM mínima de similaridade. Empate técnico é ambíguo e devolve `None`.
pub fn match_team_side(selecao: &str, evento: &str) -> Option<Side> {
    let selecao_n = normalize_str(selecao);
    let teams = split_evento_teams(evento);

    // Uma alternativa explícita com empate é Dupla Chance, não um único lado:
    // quem pede um lado falha fechado em vez de escolher metade.
    if draw_tokens().is_match(&selecao_n) && DRAW_ALTERNATIVE.is_match(&selecao_n) {
        return None;
    }

    // 0) A seleção que é SÓ o token de lado ("Casa", "Home") nomeia o lado do
    //    JOGO: num "Santos vs Casa Pia", o "Casa" sozinho não é o visitante.
    let compact = collapse_whitespace(&PARENTHETICAL_ANNOTATION.replace(&selecao_n, ""));
    if !compact.contains(' ') {
        if home_tokens().is_match(&compact) {
            return Some(Side::Home);
        }
        if away_tokens().is_match(&compact) {
            return Some(Side::Away);
        }
    }

    // 1) O NOME do time vence o token: "Casa Pia"/"Home United" são times
    //    reais, e o "casa" embutido no nome não pode decidir o lado.
    if let Some((home, away)) = &teams {
        // O nome literal inteiro primeiro: a remoção de números abaixo não
        // pode apagar identificadores reais como `BK 95` ou `Racing 01`.
        let spaced_selection = format!(" {} ", collapse_whitespace(&selecao_n));
        let mentions = |team: &str| {
            let normalized = collapse_whitespace(&normalize_str(team));
            !normalized.is_empty() && spaced_selection.contains(&format!(" {normalized} "))
        };
        let (mentions_home, mentions_away) = (mentions(home), mentions(away));
        if mentions_home != mentions_away {
            let (time, other, side) = if mentions_home {
                (home, away, Side::Home)
            } else {
                (away, home, Side::Away)
            };
            return (!category_mismatch(selecao, time, other)).then_some(side);
        }

        let without_line = regex!(r"[+-]?\d+(?:[.,]\d+)?", "g").replace(selecao, " ");
        let without_line = js::trim(&without_line);
        if !without_line.is_empty() {
            let normalized = normalize_str(without_line);
            let selection_tokens: Vec<&str> = normalized
                .split(js::is_whitespace)
                .filter(|token| js_len(token) >= 2 && !GENERIC_TEAM_SUBTOKENS.contains(token))
                .collect();
            if !selection_tokens.is_empty() {
                let home_n = normalize_str(home);
                let away_n = normalize_str(away);
                let home_words: Vec<&str> = words(&home_n).collect();
                let away_words: Vec<&str> = words(&away_n).collect();
                let sub_home = selection_tokens.iter().all(|t| home_words.contains(t));
                let sub_away = selection_tokens.iter().all(|t| away_words.contains(t));
                if sub_home != sub_away {
                    let (time, other, side) = if sub_home {
                        (home, away, Side::Home)
                    } else {
                        (away, home, Side::Away)
                    };
                    if !category_mismatch(selecao, time, other) {
                        return Some(side);
                    }
                }
            }

            let sim_home = team_side_similarity(without_line, home);
            let sim_away = team_side_similarity(without_line, away);
            let best = js::max(sim_home, sim_away);
            if best >= SIDE_MIN_SIMILARITY && (sim_home - sim_away).abs() >= SIDE_MIN_MARGIN {
                return Some(if sim_home > sim_away {
                    Side::Home
                } else {
                    Side::Away
                });
            }
        }
    }

    // 2) Rótulos genéricos completos só depois dos nomes reais: "Team 1" é o
    //    clube quando o evento usa esse nome, e o mandante nos feeds de rótulo
    //    ordinal. As anotações finais entre parênteses saem todas, e nenhuma
    //    pode contradizer o rótulo de fora ("1 (+0.5) (Clube 1)").
    let mut without_annotation = selecao_n.clone();
    let mut had_annotation = false;
    let mut annotation_sides = Vec::new();
    while let Some(found) = PARENTHETICAL_ANNOTATION.exec(&without_annotation) {
        had_annotation = true;
        let opened = regex!(r"^\s*[(\[]\s*", "").replace(found.get(0).unwrap_or(""), "");
        let inner = regex!(r"\s*[)\]]\s*$", "").replace(&opened, "");
        if HOME_LABEL.is_match(&inner) {
            annotation_sides.push(Side::Home);
        } else if AWAY_LABEL.is_match(&inner) {
            annotation_sides.push(Side::Away);
        }
        let start = found.start();
        without_annotation = js::trim(&without_annotation[..start]).to_owned();
    }
    let agreeing = |side: Side| annotation_sides.iter().all(|a| *a == side).then_some(side);
    let generic_label = collapse_whitespace(
        &regex!(r"\s+[+\-]\s*\d+(?:[.,]\d+)?\s*$", "").replace(&without_annotation, ""),
    );
    // Dígito nu só vira lado com a anotação isolada entre parênteses: ali o "1"
    // não se confunde com a linha ("1 -0.5" segue ambíguo, e "Racing 01" fica
    // protegido).
    if had_annotation && (generic_label == "1" || generic_label == "2") {
        return agreeing(if generic_label == "1" {
            Side::Home
        } else {
            Side::Away
        });
    }
    if HOME_LABEL.is_match(&generic_label) {
        return agreeing(Side::Home);
    }
    if AWAY_LABEL.is_match(&generic_label) {
        return agreeing(Side::Away);
    }

    // 3) Token explícito ("Casa"/"Fora") só quando o nome não resolveu.
    let home_token = home_tokens().is_match(&selecao_n);
    let away_token = away_tokens().is_match(&selecao_n);
    match (home_token, away_token) {
        (true, false) => Some(Side::Home),
        (false, true) => Some(Side::Away),
        _ => None,
    }
}

/// O `length` do JS: unidades UTF-16.
fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Os rótulos se dividem por uma propriedade, não por idioma: "jogo N" e
/// "game N" já significam unidade parcial no resto do sistema, então
/// "Vencedor do Jogo 1" é indistinguível de "vencedor do mapa 1". Esses
/// rótulos EXIGEM separador explícito ("Game Winner - 1"); sem ele, falha
/// fechado. `partida`/`evento`/`luta` e `match`/`event` não são unidades
/// numeradas e seguem sem exigir separador.
static LABELED_MONEYLINE_SIDE: LazyLock<Regex> = LazyLock::new(|| {
    let plain = format!(
        r"resultado final|resultado do jogo|resultado da partida|(?:vencedor|ganhador)(?: d[oa] (?:{}))?|(?:event|match)\s+winner|money\s*line",
        *SIDE_SCOPE
    );
    let unit = r"(?:vencedor|ganhador) d[oa] jogo|game\s+winner";
    compiled(
        &format!(
            r"^(?:(?:{plain})\s*[:\-]?\s*|(?:{unit})\s*[:\-]\s*)?([12x])(?:\s*(?:\((?:ft|full time|tr|tempo regulamentar|regulamentar)\)|-\s*(?:ft|full time|tr|tempo regulamentar|regulamentar)))?$"
        ),
        "",
    )
});

/// Seleção de moneyline numa fonte só para settlement e providers. Feeds 1X2
/// usam 1/X/2; o nome do time vence "draw"/"empate" para não confundir clubes
/// com esses termos. `strict` é o leitor por regra: só o nome e palavras de
/// "vence"; o resto vai para a leitura por IA, que custa menos que uma aposta
/// errada.
pub fn match_moneyline_selection(selecao: &str, evento: &str, strict: bool) -> Option<Outcome> {
    let compact = collapse_whitespace(&normalize_str(selecao));
    match compact.as_str() {
        "x" => return Some(Outcome::Draw),
        "1" => return Some(Outcome::Home),
        "2" => return Some(Outcome::Away),
        _ => {}
    }
    if let Some(found) = LABELED_MONEYLINE_SIDE.exec(&compact) {
        match found.get(1) {
            Some("1") => return Some(Outcome::Home),
            Some("2") => return Some(Outcome::Away),
            Some("x") => return Some(Outcome::Draw),
            _ => {}
        }
    }
    // "Empate" descreve a regra do DNB nestas expressões; não é o empate do 1X2.
    if DNB_ANY.is_match(&compact) {
        return None;
    }
    if moneyline_selection_asks_another_market(selecao, Some(evento)) {
        return None;
    }
    if let Some(side) = match_team_side(selecao, evento) {
        // O nome DENTRO de uma frase: o resto pode inverter a aposta
        // ("Palmeiras não perde", "Contra Flamengo"), e aí não há lado.
        return moneyline_remainder_fits(selecao, evento, side, strict).then_some(side.into());
    }
    // A PALAVRA "empate" não é a aposta no empate em duas famílias, que
    // sairiam com dinheiro invertido: Dupla Chance ("Flamengo ou Empate") e
    // anti-empate ("No Draw", "Sem empate"). "No empate" em PT é o contrário
    // de "no draw" em EN; recusa em vez de adivinhar a língua.
    let has_draw = draw_tokens().is_match(&compact);
    if has_draw && (DRAW_ALTERNATIVE.is_match(&compact) || draw_negated().is_match(&compact)) {
        return None;
    }
    has_draw.then_some(Outcome::Draw)
}

/// Palavras que só dizem "este time vence" (e o período, que o mercado confere à parte).
const MONEYLINE_DECORATION: &[&str] = &[
    "ml",
    "moneyline",
    "money",
    "line",
    "1x2",
    "vence",
    "vencer",
    "vencedor",
    "vitoria",
    "ganha",
    "ganhar",
    "win",
    "wins",
    "winner",
    "to",
    "para",
    "pra",
    "p",
    "o",
    "a",
    "resultado",
    "final",
    "match",
    "jogo",
    "partida",
    "ft",
    "tr",
    "full",
    "time",
    "regulamentar",
    "tempo",
    // Rótulos de lado sem nome ("Casa", "Time 1", "Away"): o lado vem deles.
    "home",
    "casa",
    "mandante",
    "away",
    "fora",
    "visitante",
    "team",
    "equipe",
    "clube",
    "club",
    "local",
    "visitor",
    "visiting",
    "primeiro",
    "primeira",
    "segundo",
    "segunda",
    "first",
    "second",
    "1st",
    "2nd",
    "1o",
    "2o",
    "ganhador",
    "evento",
    "confronto",
    "encontro",
    "duelo",
    "combate",
    "luta",
    "serie",
    // Escopo que inclui a prorrogação ou limita aos 90 minutos: quem confere é o período do mercado.
    "incl",
    "inc",
    "including",
    "incluindo",
    "ot",
    "overtime",
    "prorrogacao",
    "90",
    "min",
    "minutos",
    // Sufixo estadual do clube ("Flamengo RJ", "Atlético MG").
    "mg",
    "pr",
    "rj",
    "rs",
    "ba",
    "sp",
    "ce",
    "go",
];
/// O número só é o lado ao lado de um rótulo: "Time 1", "Vencedor 2".
const MONEYLINE_SIDE_LABEL: &[&str] = &[
    "time", "team", "equipe", "clube", "club", "vencedor", "ganhador", "winner",
];
/// Sobra que inverte ou combina a aposta, mesmo parecida com um pedaço de nome.
const MONEYLINE_COMPLEMENT: &[&str] = &[
    "nao",
    "not",
    "perde",
    "perder",
    "empata",
    "empatar",
    "empate",
    "draw",
    "contra",
    "against",
    "sem",
    "marca",
    "marcam",
    "marcar",
    "gol",
    "gols",
    "ambas",
    "ambos",
    "btts",
    "e",
    "and",
    "ou",
    "or",
    "mais",
    "menos",
    "over",
    "under",
    "handicap",
    "virada",
    "sofrer",
    "x",
    "vs",
    "dupla",
    "chance",
    "anula",
    "dnb",
    // A parte do jogo ("pistol round") e o método da vitória ("por KO") não são o vencedor do jogo.
    "pistol",
    "round",
    "rounds",
    "ko",
    "tko",
    "nocaute",
    "finalizacao",
    "submissao",
    "decisao",
    "metodo",
];

fn moneyline_period() -> &'static Regex {
    regex!(
        r"\b(?:[12]\s*[oº°ª]?\s*(?:tempo|etapa|parte)|(?:primeir[oa]|segund[oa])\s+(?:tempo|etapa|parte)|[12](?:st|nd)\s+half|(?:first|second)\s+half|half\s*time|intervalo|1t|2t|h1|h2|1h|2h)\b",
        "g"
    )
}

/// A seleção de moneyline pede outro mercado: traz linha ("Flamengo -1.5"),
/// placar exato ("Flamengo 2x0") ou classificação, título e vitória a zero.
/// Lida só pelo nome, pagaria a vitória simples. Com o evento, os números do
/// nome do clube (Mainz 05, 1. FC Köln) saem antes.
pub fn moneyline_selection_asks_another_market(selecao: &str, evento: Option<&str>) -> bool {
    let normalized = normalize_str(selecao);
    let dashes = regex!(r"[−–—]", "g").replace(&normalized, "-");
    // Categoria do time ("Sub-20", "U 23"): o número não é linha nem placar.
    let without_category = regex!(r"\b(?:sub|under|u)\s*-?\s*\d{2}\b", "g").replace(&dashes, " ");
    let without_period = moneyline_period().replace(&without_category, " ");
    let cleaned = regex!(r"\b1\s*x\s*2\b", "g").replace(&without_period, " ");
    // Evento vazio conta como ausente, como o `evento ? … : …` do TS.
    let text = match evento.filter(|evento| !evento.is_empty()) {
        Some(evento) => strip_team_names(&cleaned, evento),
        None => cleaned,
    };
    regex!(r"(?:^|[\s(\[])[+-]\d", "").is_match(&text)
        || regex!(r"\d[.,]\d", "").is_match(&text)
        || regex!(r"\b\d+\s*(?:[x:]|\s-\s|-)\s*\d+\b", "").is_match(&text)
        || regex!(
            r"\b(?:classific\w*|qualif\w*|avanca\w*|advances?|passar?|campea?o?|titulo)\b|\ba zero\b|\bto nil\b|\bclean sheet\b|\bsem sofrer\b",
            ""
        )
        .is_match(&text)
}

fn name_tokens(team: &str) -> Vec<String> {
    [
        team.to_owned(),
        canonicalize_team_name(team),
        expand_brazilian_club_suffix(team),
    ]
    .iter()
    .flat_map(|form| {
        let normalized = normalize_str(form);
        regex!(r"[^a-z0-9]+", "")
            .split(&normalized)
            .into_iter()
            .filter(|token| !token.is_empty())
            .collect::<Vec<_>>()
    })
    .collect()
}

fn moneyline_remainder_fits(selecao: &str, evento: &str, side: Side, strict: bool) -> bool {
    let Some((home, away)) = split_evento_teams(evento) else {
        return false;
    };
    let (own_team, other_team) = match side {
        Side::Home => (&home, &away),
        Side::Away => (&away, &home),
    };
    let own = name_tokens(own_team);
    let other = name_tokens(other_team);
    let raw = normalize_str(selecao);
    let canon = canonicalize_team_name(&moneyline_period().replace(&raw, " "));
    let tokens: Vec<&str> = canon.split(' ').filter(|token| !token.is_empty()).collect();
    let side_digit = match side {
        Side::Home => "1",
        Side::Away => "2",
    };
    let has_side_label = tokens
        .iter()
        .any(|token| MONEYLINE_SIDE_LABEL.contains(token));
    // O número só é o lado como marca à parte ("(1) Flamengo", "1 - Flamengo")
    // ou com rótulo ("Time 1").
    let digit_marks_side = regex!(r"^\s*[12]\s*[-:.)]|\(\s*[12]\s*\)|\[\s*[12]\s*\]", "")
        .is_match(&raw)
        || has_side_label;
    // Abreviação do nome ("Man Utd"): a sobra é prefixo de uma palavra do nome, ou o contrário.
    let part_of_name = |token: &str| {
        own.iter().any(|name| {
            (js_len(token) >= 3 && name.starts_with(token))
                || (js_len(name) >= 3 && token.starts_with(name.as_str()))
        })
    };
    tokens.iter().all(|token| {
        if own.iter().any(|name| name == token) {
            return true;
        }
        if MONEYLINE_COMPLEMENT.contains(token) {
            return false;
        }
        if *token == "1" || *token == "2" {
            return digit_marks_side && (*token == side_digit || (strict && has_side_label));
        }
        if MONEYLINE_DECORATION.contains(token) || GENERIC_TEAM_SUBTOKENS.contains(token) {
            return true;
        }
        if other.iter().any(|name| name == token) {
            return false;
        }
        !strict || (!token.bytes().any(|byte| byte.is_ascii_digit()) && part_of_name(token))
    })
}

/// O lado vindo de DUAS fontes: o rótulo do mercado ("Home Total Goals") e o
/// nome do time na seleção. Discordam: ninguém decide (`contradicts`). Só uma
/// fala: ela decide. Nenhuma: `None`, e o caller escolhe.
pub fn resolve_side_from_market_and_selection(
    mercado: &str,
    selecao: &str,
    evento: &str,
) -> (Option<Side>, bool) {
    let from_market = match_team_side(mercado, evento);
    let from_selection = match_team_side(selecao, evento);
    match (from_market, from_selection) {
        (Some(market), Some(selection)) if market != selection => (None, true),
        _ => (from_selection.or(from_market), false),
    }
}

/// Seleção de Draw No Bet: sempre um lado; empate puro é inválido.
pub fn match_draw_no_bet_selection(selecao: &str, evento: &str) -> Option<Side> {
    let compact = collapse_whitespace(&normalize_str(selecao));
    let without_prefix = DNB_PREFIX.replace(&compact, "");
    let without_label = DNB_SUFFIX.replace(&without_prefix, "");
    let compact = js::trim(&without_label);
    match compact {
        "1" => Some(Side::Home),
        "2" => Some(Side::Away),
        "" | "x" => None,
        _ if draw_tokens().is_match(compact) => None,
        _ => match_team_side(compact, evento),
    }
}

fn double_chance_part_outcome(part: &str, evento: &str) -> Option<Outcome> {
    let normalized = collapse_whitespace(&normalize_str(part));
    match normalized.as_str() {
        "1" => return Some(Outcome::Home),
        "2" => return Some(Outcome::Away),
        "x" | "empate" | "draw" => return Some(Outcome::Draw),
        _ => {}
    }
    let side = match_team_side(part, evento);
    let has_draw =
        draw_tokens().is_match(&normalized) || regex!(r"\bx\b", "").is_match(&normalized);
    // Lado E empate no mesmo pedaço ("Fora X") não é uma alternativa atômica.
    match (side, has_draw) {
        (Some(_), true) => None,
        (Some(side), false) => Some(side.into()),
        (None, true) => Some(Outcome::Draw),
        (None, false) => None,
    }
}

/// As duas saídas cobertas por uma seleção de Dupla Chance, na ordem casa,
/// empate, fora. A mesma fonte do settlement e da equivalência sharp: uma
/// grafia não pode ser precificável e não liquidável.
pub fn match_double_chance_selection(selecao: &str, evento: &str) -> Option<(Outcome, Outcome)> {
    let normalized = collapse_whitespace(&normalize_str(selecao));
    let without_prefix = DOUBLE_CHANCE_PREFIX.replace(&normalized, "");
    let without_label = DOUBLE_CHANCE_SUFFIX.replace(&without_prefix, "");
    let normalized = js::trim(&without_label);
    let compact: String = normalized
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect();
    match compact.as_str() {
        "1x" | "x1" => return Some((Outcome::Home, Outcome::Draw)),
        "x2" | "2x" => return Some((Outcome::Draw, Outcome::Away)),
        "12" | "21" => return Some((Outcome::Home, Outcome::Away)),
        _ => {}
    }
    // "Time +1" declara handicap, não a dupla time/casa; "1 + 2" continua.
    if regex!(r"\+\s*\d|(?:^|\s)[−–-]\s*\d", "").is_match(normalized)
        && !regex!(r"^[12x]\s*\+\s*[12x]$", "").is_match(normalized)
    {
        return None;
    }
    let conjunction = regex!(r"^(.+?)\s+(?:e|y|and|&)\s+(.+)$", "")
        .exec(normalized)
        .or_else(|| regex!(r"^(.+?)\s*,\s*(.+)$", "").exec(normalized));
    if let Some(found) = conjunction {
        // `e` também aparece dentro de nomes: só vale com ao menos uma
        // alternativa que é um outcome inequívoco (Casa/Empate/1/X/2...).
        let explicit = regex!(
            r"^(?:1|2|x|home|away|casa|fora|mandante|visitante|draw|empate)$",
            ""
        );
        let any_explicit = [1, 2].iter().any(|group| {
            explicit.is_match(js::trim(&normalize_str(found.get(*group).unwrap_or(""))))
        });
        if !any_explicit {
            return None;
        }
    }
    let parts: Vec<String> = DC_SPLIT
        .split(normalized)
        .into_iter()
        .map(|part| js::trim(&part).to_owned())
        .filter(|part| !part.is_empty())
        .collect();
    let [first, second] = parts.as_slice() else {
        return None;
    };
    let one = double_chance_part_outcome(first, evento)?;
    let other = double_chance_part_outcome(second, evento)?;
    let has = |outcome| one == outcome || other == outcome;
    if one == other {
        return None;
    }
    if has(Outcome::Home) && has(Outcome::Draw) {
        Some((Outcome::Home, Outcome::Draw))
    } else if has(Outcome::Draw) && has(Outcome::Away) {
        Some((Outcome::Draw, Outcome::Away))
    } else {
        Some((Outcome::Home, Outcome::Away))
    }
}

pub(crate) fn regexes() -> Vec<&'static Regex> {
    vec![
        home_tokens(),
        away_tokens(),
        draw_tokens(),
        &*DRAW_ALTERNATIVE,
        &*DC_SPLIT,
        draw_negated(),
        &*DNB_ANY,
        &*DNB_PREFIX,
        &*DNB_SUFFIX,
        &*DOUBLE_CHANCE_PREFIX,
        &*DOUBLE_CHANCE_SUFFIX,
        &*HOME_LABEL,
        &*AWAY_LABEL,
        &*PARENTHETICAL_ANNOTATION,
        &*LABELED_MONEYLINE_SIDE,
        brazilian_state_suffix(),
        moneyline_period(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nome_do_time_vence_o_token() {
        assert_eq!(
            match_team_side("Casa Pia +0.5", "Santos vs Casa Pia"),
            Some(Side::Away)
        );
        assert_eq!(
            match_team_side("Casa", "Santos vs Casa Pia"),
            Some(Side::Home)
        );
        assert_eq!(
            match_team_side("Time 1 (+0.5)", "Flamengo vs Palmeiras"),
            Some(Side::Home)
        );
        assert_eq!(
            match_team_side("América-MG", "América-MG vs América-RJ"),
            Some(Side::Home)
        );
        assert_eq!(
            match_team_side("Flamengo ou Empate", "Flamengo vs Palmeiras"),
            None
        );
    }

    #[test]
    fn remove_o_nome_sem_apagar_a_linha() {
        assert_eq!(
            strip_team_names("Schalke 04 +1.5", "Schalke 04 vs 1. FC Köln").trim(),
            "+1.5"
        );
        assert_eq!(remove_token("x +1.5 1 a", "1", true), "x +1.5   a");
        assert_eq!(remove_token("over 20 sub", "20", true), "over   sub");
    }

    #[test]
    fn moneyline_dnb_e_dupla_chance() {
        let evento = "Flamengo vs Palmeiras";
        assert_eq!(
            match_moneyline_selection("Flamengo", evento, false),
            Some(Outcome::Home)
        );
        assert_eq!(
            match_moneyline_selection("Palmeiras não perde", evento, false),
            None
        );
        assert_eq!(match_moneyline_selection("No Draw", evento, false), None);
        assert_eq!(
            match_moneyline_selection("Game Winner - 2", evento, false),
            Some(Outcome::Away)
        );
        assert_eq!(
            match_draw_no_bet_selection("Flamengo DNB", evento),
            Some(Side::Home)
        );
        assert_eq!(
            match_double_chance_selection("Flamengo ou Empate", evento),
            Some((Outcome::Home, Outcome::Draw))
        );
        assert_eq!(match_double_chance_selection("Flamengo +1", evento), None);
        assert_eq!(
            resolve_side_from_market_and_selection("Home Total", "Palmeiras Over 1.5", evento),
            (None, true)
        );
    }
}
