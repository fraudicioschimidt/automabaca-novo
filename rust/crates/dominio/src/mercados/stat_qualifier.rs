//! Vocabulário único de mercados cuja UNIDADE é uma estatística (cartões,
//! escanteios, props de jogador…), e não o placar da partida, portado de
//! `src/domain/mercados/stat-qualifier.ts`.
//!
//! Dois consumidores precisam dele antes do settlement: a coerção de mercado
//! no registro, que não pode apagar a estatística ao reescrever o rótulo, e o
//! roteamento de providers. O espelho SQL do lote de liquidação é derivado
//! destas mesmas listas: divergir ali tira a aposta do IA-Judge.

use super::accents::accentuate;
use crate::js;
use crate::sports::registry::{
    UnidadeDoPlacar, esportes_com_unidade, termos_de_unidade_sem_placar,
};
use crate::text_normalization::normalize_str;
use js_regex::{Regex, regex};
use std::sync::LazyLock;

/// Fonte única das alternativas; o espelho SQL é gerado daqui
/// (`non_score_stat_sql_terms`).
///
/// Subfamílias compostas vêm antes do termo genérico. Além de proteger o
/// placar, elas permitem que a seleção refine o mercado sem depender de o
/// qualificador ficar colado à palavra genérica ("Cartões Amarelos Over",
/// "Chutes no Gol Over"). "3 point"/"three point" SEM o `-er` existe e é como
/// a casa costuma escrever a linha; só `pointers?` deixaria a cesta de três ser
/// julgada pelo PLACAR de pontos.
pub const NON_SCORE_STAT_TERMS: &str = concat!(
    r"(?:yellow|red)\s+cards?|cartoes?\s+(?:amarelos?|vermelhos?)|amarelos?|vermelhos?|",
    r"chutes?\s+(?:ao?|no)\s+(?:gol|alvo)|finalizacoes?\s+(?:ao?|no)\s+(?:gol|alvo)|",
    r"remates?\s+(?:a(?:o)?|no)\s+baliza|remates?\s+(?:a(?:o)?|no)\s+alvo|",
    r"remates?\s+(?:a(?:o)?|no)\s+gol|remates?\s+enquadrados?|",
    r"shots?\s+on\s+(?:target|goal)|duplas?\s+faltas?|",
    r"sofre\s+faltas?|comete\s+faltas?|fouls?\s+suffered|fouls?\s+committed|",
    r"posse\s+de\s+bola|ball\s+possession|foras?\s+de\s+jogo|",
    r"pontapes?\s+de\s+baliza|tiros?\s+de\s+meta|goal\s+kicks?|",
    r"free\s+kicks?|grandes?\s+penalidades?|lancamentos?\s+laterais?|throw[\s-]*ins?|",
    r"ataques?\s+perigosos?|dangerous\s+attacks?|bolas?\s+na\s+trave|woodwork|",
    r"cartao|cartoes|carteos|cards?|bookings?|escanteios?|cantos?|corners?|chutes?|shots?|remates?|",
    r"finalizacoes?|faltas?|fouls?|torres?|towers?|mapa|mapas|maps?|kills?|abates?|deaths?|mortes?|",
    r"dragons?|dragoes?|barons?|baroes?|inhibitors?|inibidores?|",
    r"strikes?|golpes?|takedowns?|quedas?|submissions?|finalizacoes? de luta|",
    r"defesas?|saves?|jogador|player|scorer|marcador|artilheiro|assistencias?|assists?|",
    r"rebounds?|rebotes?|aces|bases|steals?|roubos?|roubadas?|turnovers?|perdas?|",
    r"blocks?|bloqueios?|tocos?|hits?|",
    r"strikeouts?|double faults?|faltas duplas?|3[\s-]*pointers?|3[\s-]*points?|",
    r"three pointers?|three points?|triples?|triplas?|pra|",
    r"offsides?|impedimentos?|passes?|touches?|toques?|interceptions?|interceptacao|",
    r"interceptacoes?|",
    r"crosses?|cruzamentos?|tackles?|desarmes?|clearances?|cortes?|afastamentos?|",
    r"sacks?|first downs?|home runs?|",
    r"rbis?|field goals?|posse|livres?|penaltis?|substituicoes?|substitutions?|laterais?|",
    r"ataques?|attacks?",
);

/// Como a casa liga o NÚMERO à estatística: direto ("2 cartões"), com o `+` de
/// "no mínimo" ("2+ cards") ou por extenso ("2 or more cards").
///
/// Sem o `+` e o "or more" a seleção não declara estatística, o mercado segue
/// liquidável por PLACAR e, como a seleção carrega o nome do time, o resolver
/// de lado casa e liquida: "Time 2+ cards" num jogo 2×1 viraria `WON` sem olhar
/// um cartão.
const CONECTOR_DE_LINHA: &str = r"(?:\s*\+|\s+(?:or more|ou mais|no minimo|at least))?\s*";

fn compiled(source: &str, flags: &str) -> Regex {
    Regex::cataloged(source, flags)
        .unwrap_or_else(|error| panic!("regex inválida /{source}/{flags}: {error}"))
}

static NON_SCORE_STAT: LazyLock<Regex> =
    LazyLock::new(|| compiled(&format!(r"\b(?:{NON_SCORE_STAT_TERMS})\b"), ""));
static LINE_THEN_STAT: LazyLock<Regex> = LazyLock::new(|| {
    compiled(
        &format!(r"\d+(?:[.,]\d+)?{CONECTOR_DE_LINHA}(?:{NON_SCORE_STAT_TERMS})\b"),
        "",
    )
});
/// `9.5` sem sinal, ou palavra de direção. O sinal fica de fora: `[+\-]?\d`
/// fazia "Las Vegas Aces -3.5", handicap num time da WNBA, parecer linha de
/// aces. Handicap estatístico de verdade nomeia a estatística no MERCADO.
static STAT_THEN_LINE: LazyLock<Regex> = LazyLock::new(|| {
    compiled(
        &format!(r"\b(?:{NON_SCORE_STAT_TERMS})\s*(?:over|under|mais|menos|acima|abaixo|\d)"),
        "",
    )
});

fn both_teams_cards() -> &'static Regex {
    regex!(
        concat!(
            // Rótulo explícito: "Both Teams Cards" ou "Ambas as equipes recebem
            // 2+ cartões". O limite impede atravessar outra aposta em legendas
            // com vários blocos.
            r"\b(?:both teams(?: to)? receive|ambas(?: as equipes)? recebem|ambos(?: os times)? recebem)\b[^\n]{0,80}\b(?:cards?|bookings?|cartao|cartoes|carteos)\b",
            "|",
            r"\bboth teams\s+(?:cards?|bookings?)\b",
            "|",
            // "Both Teams Over 0.5 cards": a direção fica entre o sujeito e a
            // unidade. Sem isto o classificador de jogador lia "Both Teams"
            // como atleta.
            r"\b(?:both teams|ambas(?: as equipes)?|ambos(?: os times)?)\s+(?:over|under|mais|menos|acima|abaixo)\s+\d+(?:[.,]\d+)?\s+(?:cards?|bookings?|cartao|cartoes|carteos)\b",
            "|",
            // "Ambas 2+ cartões": o número vem logo depois do sujeito, para
            // "ambas marcam e over 2 cards" (outro combo) não virar este mercado.
            r"\b(?:both teams|ambas(?: as equipes)?|ambos(?: os times)?)\s+(?:\+\s*)?\d+(?:[.,]\d+)?(?:\s*\+|\s+(?:or more|ou mais|no minimo|at least))?\s+(?:cards?|bookings?|cartao|cartoes|carteos)\b",
        ),
        ""
    )
}

/// A linha exige que CADA time alcance o mínimo de cartões, não o total do jogo.
pub fn is_both_teams_cards_text(text: &str) -> bool {
    both_teams_cards().is_match(&normalize_str(text))
}

/// A seleção DECLARA uma linha de estatística, não apenas contém uma palavra
/// que por acaso é nome de estatística: separa "Total / Over 9.5 Aces" de "Las
/// Vegas Aces" no moneyline, para a coerção de mercado e para o settlement.
pub fn selecao_declara_linha_de_estatistica(selecao: &str) -> bool {
    let selection = normalize_str(selecao);
    LINE_THEN_STAT.is_match(&selection) || STAT_THEN_LINE.is_match(&selection)
}

/// Mercados de estatística (cartões, escanteios, props…) nunca resolvem por placar.
pub fn has_non_score_stat_qualifier(mercado: &str, selecao: &str) -> bool {
    NON_SCORE_STAT.is_match(&normalize_str(mercado))
        || selecao_declara_linha_de_estatistica(selecao)
}

/// Unidade da linha e esportes em que ela É o placar. Exportada como dado
/// porque o filtro SQL precisa do mesmo par (termo, esporte) para não admitir
/// o que o domínio recusa. Toda regra vale só DENTRO dos esportes listados;
/// fora deles, com esporte conhecido, falha fechado.
pub struct ScoreUnitRule {
    pub terms: &'static [&'static str],
    pub sports: Vec<String>,
}

/// `[goals, runs, points]`, na ordem do TypeScript.
pub static SCORE_UNIT_RULES: LazyLock<[ScoreUnitRule; 3]> = LazyLock::new(|| {
    [
        ScoreUnitRule {
            terms: &["gol", "gols", "goal", "goals"],
            sports: esportes_com_unidade(UnidadeDoPlacar::Gols),
        },
        // Corrida só é o placar em beisebol, softbol e críquete. Softbol não é
        // modalidade canônica, mas `esporte` é texto livre em dado legado.
        ScoreUnitRule {
            terms: &["runs", "run", "corridas", "corrida"],
            sports: esportes_com_unidade(UnidadeDoPlacar::Corridas)
                .into_iter()
                .chain(["softball".to_owned(), "softbol".to_owned()])
                .collect(),
        },
        // Ponto só é o placar onde o painel conta pontos: em hockey, futebol
        // ou eSports "pontos" não é o número que o feed entrega.
        ScoreUnitRule {
            terms: &["points", "point", "pontos", "ponto"],
            sports: esportes_com_unidade(UnidadeDoPlacar::Pontos),
        },
    ]
});

/// Unidades que nomeiam o placar ou uma parcial dele (gols, pontos, corridas,
/// sets, games, mapas…).
pub fn score_qualifier_terms() -> Vec<String> {
    let mut terms: Vec<String> = SCORE_UNIT_RULES
        .iter()
        .flat_map(|rule| rule.terms.iter().map(|term| (*term).to_owned()))
        .collect();
    for term in termos_de_unidade_sem_placar() {
        match term.strip_suffix("s?") {
            Some(singular) => {
                terms.push(singular.to_owned());
                terms.push(format!("{singular}s"));
            }
            None => terms.push(term.to_owned()),
        }
    }
    terms
}

/// A lista sem repetição, na ordem da primeira vez (o `new Set` do JS).
fn unique(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = Vec::new();
    for item in items {
        if !seen.contains(&item) {
            seen.push(item);
        }
    }
    seen
}

static SCORE_QUALIFIER: LazyLock<Regex> = LazyLock::new(|| {
    compiled(
        &format!(r"\b(?:{})\b", unique(score_qualifier_terms()).join("|")),
        "",
    )
});

fn structural_qualifier() -> &'static Regex {
    regex!(
        r"^(?:asian|match|game|jogo|partida|team|time|equipe|home|away|casa|visitante|mandante)(?:\s+(?:match|game|jogo|partida|team|time|equipe))?$",
        ""
    )
}

fn named_qualifier_patterns() -> [&'static Regex; 5] {
    [
        regex!(r"\btotal\s+(?:de|do|da)\s+(.+)$", ""),
        regex!(r"\btotal\s*\(([^)]+)\)", ""),
        regex!(
            r"^(.+?)\s+total(?:\s*[-–—]?\s*(?:match|game|jogo|partida))?$",
            ""
        ),
        regex!(r"\bhandicap\s+(?:de|do|da)\s+(.+)$", ""),
        regex!(
            r"^(?:time|team|equipe)\s*(?:1|2|da casa|visitante|home|away)\s*[-–—:]\s*(.+)$",
            ""
        ),
    ]
}

fn scope_words() -> &'static Regex {
    regex!(r"\b(?:ft|full time|match|game|jogo|partida)\b", "g")
}

fn numbers() -> &'static Regex {
    regex!(r"\b\d+(?:[.,]\d+)?\b", "g")
}

fn non_alphanumeric() -> &'static Regex {
    regex!(r"[^a-z0-9]+", "g")
}

fn whitespace_runs() -> &'static Regex {
    regex!(r"\s+", "g")
}

/// O qualificador sem escopo, números e pontuação, em espaço simples.
fn bare_qualifier(qualifier: &str) -> String {
    let without_scope = scope_words().replace(qualifier, " ");
    let without_numbers = numbers().replace(&without_scope, " ");
    let words = non_alphanumeric().replace(&without_numbers, " ");
    js::trim(&whitespace_runs().replace(&words, " ")).to_owned()
}

/// Um rótulo que nomeia a UNIDADE de Total/Handicap não pode cair aberto no
/// placar só porque essa unidade ainda não entrou no vocabulário: é o último
/// portão financeiro para o universo aberto de nomes de mercado.
pub fn has_unknown_score_qualifier(mercado: &str) -> bool {
    let normalized = normalize_str(mercado);
    let market = whitespace_runs().replace(&normalized, " ");
    let market = js::trim(&market);
    named_qualifier_patterns().into_iter().any(|pattern| {
        let Some(found) = pattern.exec(market) else {
            return false;
        };
        let qualifier = bare_qualifier(found.get(1).unwrap_or(""));
        !qualifier.is_empty()
            && !structural_qualifier().is_match(&qualifier)
            && !NON_SCORE_STAT.is_match(&qualifier)
            && !SCORE_QUALIFIER.is_match(&qualifier)
    })
}

/// Termos aceitos pelo espelho SQL ao filtrar qualificadores nomeados.
pub fn known_score_qualifier_sql_terms() -> Vec<String> {
    unique(
        score_qualifier_terms()
            .into_iter()
            .map(|term| match term.strip_suffix("s?") {
                Some(singular) => singular.to_owned(),
                None => term,
            }),
    )
}

/// Termos `contains` da denylist SQL, derivados das mesmas alternativas da
/// regex. Alternativa com sintaxe de regex além do plural opcional fica de
/// fora: essas já têm filtro escrito à mão, e um teste cobra a cobertura.
pub fn non_score_stat_sql_terms() -> Vec<String> {
    let mut terms = Vec::new();
    for alternative in NON_SCORE_STAT_TERMS.split('|') {
        let without_plural = alternative.strip_suffix("s?").unwrap_or(alternative);
        if without_plural.contains(['[', ']', '(', ')', '?', '*', '+', '{', '}', '\\']) {
            continue;
        }
        terms.push(without_plural.to_owned());
        let accented = accentuate(without_plural);
        if accented != without_plural {
            terms.push(accented);
        }
    }
    unique(terms)
}

/// Unidades que o placar agregado nunca responde, derivadas do registro de
/// esportes: esporte novo (dardos com `legs`, snooker com `frames`) traz a
/// recusa junto.
static UNIDADE_SEM_PLACAR: LazyLock<Regex> = LazyLock::new(|| {
    compiled(
        &format!(r"\b(?:{})\b", termos_de_unidade_sem_placar().join("|")),
        "",
    )
});

/// Espelho SQL da recusa acima. `contains` no Postgres é substring, não
/// palavra: o termo vai no plural, para não casar pedaço de outra palavra. Mais
/// estreito que o domínio no singular, e é o lado seguro: o caller revalida no
/// domínio.
pub fn score_unit_terms_for_sql() -> Vec<String> {
    termos_de_unidade_sem_placar()
        .into_iter()
        .map(|term| match term.strip_suffix("s?") {
            Some(singular) => format!("{singular}s"),
            None => term.to_owned(),
        })
        .collect()
}

fn game_or_round_unit() -> &'static Regex {
    regex!(
        r"\b(?:game\s+(?:handicap|total)|total\s+game|rounds|rounds?\s+(?:total|handicap)|(?:total|handicap)\s+(?:de\s+)?rounds?)\b",
        ""
    )
}

/// Unidade da linha que NÃO é o placar agregado do esporte. A coerção de
/// mercado precisa da mesma resposta ANTES do settlement: reescrever o rótulo
/// apagaria a evidência. Games e sets ficam recusados até comprovar a unidade
/// do feed; round é a unidade de dentro do mapa/luta, não o placar em mapas.
pub fn has_score_unit_mismatch(mercado: &str, selecao: &str, esporte: Option<&str>) -> bool {
    let combined = normalize_str(&format!("{mercado} {selecao}"));
    UNIDADE_SEM_PLACAR.is_match(&combined)
        || game_or_round_unit().is_match(&combined)
        || has_sport_score_unit_mismatch(mercado, selecao, esporte)
}

static SCORE_UNIT_TERMS: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    SCORE_UNIT_RULES
        .each_ref()
        .map(|rule| compiled(&format!(r"\b(?:{})\b", rule.terms.join("|")), ""))
});

/// Unidade explícita do placar que pertence a outra modalidade.
pub fn has_sport_score_unit_mismatch(mercado: &str, selecao: &str, esporte: Option<&str>) -> bool {
    let normalized = normalize_str(esporte.unwrap_or(""));
    let sport = js::trim(&normalized);
    if sport.is_empty() {
        return false;
    }
    let combined = normalize_str(&format!("{mercado} {selecao}"));
    SCORE_UNIT_RULES
        .iter()
        .zip(SCORE_UNIT_TERMS.iter())
        .any(|(rule, terms)| {
            terms.is_match(&combined) && !rule.sports.iter().any(|known| known == sport)
        })
}

pub(crate) fn regexes() -> Vec<&'static Regex> {
    let mut all: Vec<&'static Regex> = vec![
        &*NON_SCORE_STAT,
        &*LINE_THEN_STAT,
        &*STAT_THEN_LINE,
        both_teams_cards(),
        &*SCORE_QUALIFIER,
        structural_qualifier(),
        &*UNIDADE_SEM_PLACAR,
        scope_words(),
        numbers(),
        non_alphanumeric(),
        whitespace_runs(),
        game_or_round_unit(),
    ];
    all.extend(named_qualifier_patterns());
    all.extend(SCORE_UNIT_TERMS.iter());
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estatistica_nao_e_placar() {
        assert!(has_non_score_stat_qualifier("Total de Cartões", "Over 4.5"));
        assert!(has_non_score_stat_qualifier("Total", "Over 9.5 Aces"));
        assert!(!has_non_score_stat_qualifier(
            "Moneyline",
            "Las Vegas Aces -3.5"
        ));
        assert!(is_both_teams_cards_text("Ambas 2+ cartões"));
        assert!(!is_both_teams_cards_text("ambas marcam e over 2 cards"));
    }

    #[test]
    fn unidade_do_placar_por_esporte() {
        assert!(has_score_unit_mismatch(
            "Total de Games",
            "Over 22.5",
            Some("tennis")
        ));
        assert!(has_score_unit_mismatch(
            "Total de Pontos",
            "Over 5.5",
            Some("hockey")
        ));
        assert!(!has_score_unit_mismatch(
            "Total de Pontos",
            "Over 150.5",
            Some("basketball")
        ));
        assert!(!has_sport_score_unit_mismatch(
            "Total de Gols",
            "Over 2.5",
            None
        ));
        assert!(has_unknown_score_qualifier("Total de Xyzzy"));
        assert!(!has_unknown_score_qualifier("Total de Gols FT"));
        assert!(!has_unknown_score_qualifier("Total de Escanteios"));
    }

    #[test]
    fn espelho_sql() {
        let terms = non_score_stat_sql_terms();
        assert!(terms.contains(&"cartao".to_owned()));
        assert!(terms.contains(&"cartão".to_owned()));
        assert!(!terms.iter().any(|term| term.contains('\\')));
        assert!(score_unit_terms_for_sql().contains(&"sets".to_owned()));
        assert!(known_score_qualifier_sql_terms().contains(&"set".to_owned()));
    }
}
