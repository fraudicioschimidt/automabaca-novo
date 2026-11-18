//! Detecção do esporte pelo texto do post e decisão a partir da leitura da IA,
//! portadas de `src/domain/sports/detect.ts`.

use super::registry::{canonical_sport, competition_signals, emoji_signals, text_signals};
use crate::js;
use crate::text_normalization::normalize_str;
use js_regex::{Regex, regex};

/// Sobe a cada mudança de comportamento do resolvedor: é por ela que apostas
/// antigas podem ser reavaliadas. Porte não é mudança de comportamento.
pub const SPORT_RESOLVER_VERSION: u32 = 19;
/// Confirmação sem revisão: evidência de 90 ou mais para um esporte e nenhum
/// outro esporte a partir de `SPORT_DISSENT_MIN_CONFIDENCE`.
pub const SPORT_AUTO_CONFIRM_MIN_CONFIDENCE: f64 = 90.0;
/// A partir daqui, a evidência de outro esporte segura a confirmação automática.
pub const SPORT_DISSENT_MIN_CONFIDENCE: f64 = 70.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Confirmed,
    Pending,
    Conflict,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Confirmed => "CONFIRMED",
            Status::Pending => "PENDING",
            Status::Conflict => "CONFLICT",
        }
    }
}

/// As fontes que a detecção produz; as outras (`TEAM_ID`, `MANUAL`…) nascem
/// fora do domínio.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Text,
    Emoji,
    Competition,
    Llm,
    Unresolved,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Text => "TEXT",
            Source::Emoji => "EMOJI",
            Source::Competition => "COMPETITION",
            Source::Llm => "LLM",
            Source::Unresolved => "UNRESOLVED",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Evidence {
    pub source: Source,
    pub sport: &'static str,
    pub confidence: f64,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub sport: Option<&'static str>,
    pub status: Status,
    pub confidence: f64,
    pub source: Source,
    pub evidence: Vec<Evidence>,
}

fn unresolved(status: Status, evidence: Vec<Evidence>) -> Decision {
    Decision {
        sport: None,
        status,
        confidence: evidence
            .iter()
            .fold(0.0, |best, item| js::max(best, item.confidence)),
        source: Source::Unresolved,
        evidence,
    }
}

// Desambiguação entre modalidades que compartilham palavra. A lista não
// encolheu quando handebol, futsal, rugby, dardos e snooker ganharam contrato
// próprio, e é de propósito: o guarda impede o sinal de futebol de disparar,
// não a modalidade de existir. "Champions League de handebol" continua
// handebol: sem o guarda, a competição promoveria futebol, o texto promoveria
// handebol, e as duas evidências juntas dariam conflito em vez de resposta.
fn unsupported_soccer_context() -> &'static Regex {
    regex!(
        r"\b(?:futsal|beach soccer|futebol de areia|futebol society|society|fut\s*7|futebol australiano|australian football|australian rules|futebol gaelico|gaelic football|virtual soccer|soccer virtual|futebol virtual|handball|handebol|water polo|polo aquatico|rugby|darts?|dardos|sinuca|snooker)\b",
        ""
    )
}
fn unsupported_basketball_context() -> &'static Regex {
    regex!(
        r"\b(?:3\s*[x×]\s*3|virtual basketball|basketball virtual|basquete virtual)\b",
        ""
    )
}
fn unsupported_tennis_context() -> &'static Regex {
    regex!(
        r"\b(?:table tennis|tenis de mesa|ping pong|wheelchair tennis|tenis (?:em )?cadeira de rodas|virtual tennis|tennis virtual|tenis virtual)\b",
        ""
    )
}
fn unsupported_volleyball_context() -> &'static Regex {
    regex!(r"\b(?:beach volleyball|volei de praia)\b", "")
}
fn unsupported_hockey_context() -> &'static Regex {
    regex!(
        r"\b(?:field hockey|grass hockey|hockey (?:sobre|de) grama|hoquei (?:sobre|de) grama|hoquei (?:em|sobre|de) patins|roller hockey|rink hockey)\b",
        ""
    )
}
fn club_name_hockey_context() -> &'static Regex {
    regex!(r"\b(?:hockey|hoquei)\s+(?:club|clube)\b", "")
}

/// Nomes de liga de futebol que basquete, vôlei, handebol e dardos também usam
/// ("🏀 Serie A", "🤾 Champions League", "Basquete Bundesliga", a "Premier
/// League" dos dardos): sozinhos, não provam o futebol.
pub const SHARED_SOCCER_LEAGUE: &str =
    r"^(?:champions league|premier league|serie [abcd]|la liga|bundesliga)$";

fn shared_soccer_league() -> &'static Regex {
    regex!(SHARED_SOCCER_LEAGUE, "")
}

pub(crate) fn regexes() -> Vec<&'static Regex> {
    vec![
        unsupported_soccer_context(),
        unsupported_basketball_context(),
        unsupported_tennis_context(),
        unsupported_volleyball_context(),
        unsupported_hockey_context(),
        club_name_hockey_context(),
        shared_soccer_league(),
    ]
}

fn has_unsupported_variant(sport: &str, normalized: &str) -> bool {
    match sport {
        "Soccer" => unsupported_soccer_context().is_match(normalized),
        "Basketball" => unsupported_basketball_context().is_match(normalized),
        "Tennis" => unsupported_tennis_context().is_match(normalized),
        "Volleyball" => unsupported_volleyball_context().is_match(normalized),
        "Hockey" => {
            unsupported_hockey_context().is_match(normalized)
                || club_name_hockey_context().is_match(normalized)
        }
        _ => false,
    }
}

fn all_terms<'t>(pattern: &Regex, normalized: &'t str) -> Vec<&'t str> {
    pattern
        .exec_all(normalized)
        .iter()
        .filter_map(|found| found.get(0))
        .collect()
}

/// O emoji ou o nome da modalidade. Estatística ("3 pontos") aparece em post
/// de futebol.
fn names_sport(item: &Evidence) -> bool {
    item.source == Source::Emoji
        || (item.source == Source::Text && canonical_sport(&item.value) == Some(item.sport))
}

/// A liga de futebol do texto, a só do futebol antes da compartilhada. No
/// lote, a legenda inteira do post entra para cada item, e o emoji ou o nome
/// de outra modalidade pode ser de outro jogo: só a leitura do próprio item
/// decide.
/// - Lido como outra modalidade: a liga compartilhada cede, mesmo sem o nome
///   dela no texto ("Serie A" + total de pontos lido como basquete); quem
///   acha o jogo decide.
/// - Lido como futebol, ou sem leitura: com outra modalidade no texto, a
///   palavra dela só segura a liga na mesma linha ("Lega Basket Serie A"), e
///   o post misto fica em conflito. Sem leitura, a Champions League ainda
///   cede à modalidade nomeada ("🤾 Europe - Champions League").
fn soccer_competition_term<'t>(
    pattern: &Regex,
    normalized: &'t str,
    other_sport_in_text: bool,
    has_named_sports: bool,
    item_sport: Option<&str>,
) -> Option<&'t str> {
    let shared = shared_soccer_league();
    if let Some(item) = item_sport
        && item != "Soccer"
    {
        return all_terms(pattern, normalized)
            .into_iter()
            .find(|term| !shared.is_match(term));
    }
    let found: Vec<&str> = if other_sport_in_text {
        normalized
            .split('\n')
            .flat_map(|line| all_terms(pattern, line))
            .collect()
    } else {
        all_terms(pattern, normalized)
    };
    let terms: Vec<&str> = if item_sport.is_none() && has_named_sports {
        found
            .into_iter()
            .filter(|term| *term != "champions league")
            .collect()
    } else {
        found
    };
    terms
        .iter()
        .find(|term| !shared.is_match(term))
        .or(terms.first())
        .copied()
}

/// Os sinais do texto: emoji, nome ou estatística da modalidade e competição.
/// `item_sport` é o esporte em que a leitura do próprio item (a IA) pôs a
/// aposta; vazio vale como ausente, como no JavaScript.
pub fn detect_sport_from_text(text: &str, item_sport: Option<&str>) -> Decision {
    let item_sport = item_sport.filter(|sport| !sport.is_empty());
    let normalized = normalize_str(text);
    let mut evidence: Vec<Evidence> = Vec::new();

    for (emoji, sport) in emoji_signals() {
        if text.contains(emoji) && !has_unsupported_variant(sport, &normalized) {
            evidence.push(Evidence {
                source: Source::Emoji,
                sport,
                confidence: 95.0,
                value: emoji.to_owned(),
            });
        }
    }
    for (pattern, sport) in text_signals() {
        let terms = all_terms(pattern, &normalized);
        // O nome da modalidade, quando o texto o traz, vale mais que a estatística.
        let value = terms
            .iter()
            .find(|term| canonical_sport(term) == Some(sport))
            .or(terms.first())
            .filter(|value| !value.is_empty());
        let Some(value) = value else { continue };
        if has_unsupported_variant(sport, &normalized) {
            continue;
        }
        evidence.push(Evidence {
            source: Source::Text,
            sport,
            confidence: 95.0,
            value: (*value).to_owned(),
        });
    }
    let competitions: Vec<(&Regex, &str)> = competition_signals()
        .filter(|(_, sport)| !has_unsupported_variant(sport, &normalized))
        .collect();
    let other_sport_in_text = evidence.iter().any(|item| item.sport != "Soccer")
        || competitions
            .iter()
            .any(|(pattern, sport)| *sport != "Soccer" && pattern.is_match(&normalized));
    let has_named_sports = evidence
        .iter()
        .any(|item| item.sport != "Soccer" && names_sport(item));
    for (pattern, sport) in competitions {
        let value = if sport == "Soccer" {
            soccer_competition_term(
                pattern,
                &normalized,
                other_sport_in_text,
                has_named_sports,
                item_sport,
            )
        } else {
            pattern.exec(&normalized).and_then(|found| found.get(0))
        };
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            evidence.push(Evidence {
                source: Source::Competition,
                sport,
                confidence: 95.0,
                value: value.to_owned(),
            });
        }
    }

    let mut sports: Vec<&'static str> = Vec::new();
    for item in &evidence {
        if !sports.contains(&item.sport) {
            sports.push(item.sport);
        }
    }
    match sports.as_slice() {
        [] => unresolved(Status::Pending, Vec::new()),
        [sport] => {
            let sport = *sport;
            // O primeiro de maior confiança, como o `sort` estável do JS.
            let best = evidence.iter().filter(|item| item.sport == sport).fold(
                None::<&Evidence>,
                |best, item| match best {
                    Some(best) if item.confidence > best.confidence => Some(item),
                    Some(best) => Some(best),
                    None => Some(item),
                },
            );
            Decision {
                sport: Some(sport),
                status: Status::Confirmed,
                confidence: best.map_or(95.0, |item| item.confidence),
                source: best.map_or(Source::Text, |item| item.source),
                evidence,
            }
        }
        _ => unresolved(Status::Conflict, evidence),
    }
}

/// A confiança que a IA declarou (0 a 1), em pontos, com teto 85.
fn llm_confidence(confidence: Option<f64>) -> f64 {
    js::min(
        85.0,
        js::max(0.0, js::round(confidence.unwrap_or(0.85) * 100.0)),
    )
}

/// A IA isolada propõe candidato com teto 85 e status pendente. Quando traz
/// evidência textual visível (cabeçalho ou texto do bilhete, ou a legenda)
/// comprovada pela detecção do texto, a decisão é promovida a confirmada com
/// a confiança da detecção (anti-alucinação).
pub fn llm_sport_decision(
    sport: Option<&str>,
    confidence: Option<f64>,
    evidence_text: Option<&str>,
) -> Decision {
    let Some(sport) = canonical_sport(sport.unwrap_or("")) else {
        return unresolved(Status::Pending, Vec::new());
    };
    let clean_evidence = evidence_text.map(js::trim).filter(|text| !text.is_empty());
    if let Some(clean) = clean_evidence {
        // A mesma regra da captura: a liga compartilhada da evidência ("🏀
        // Serie A") cede à modalidade que a IA leu no item.
        let verified = detect_sport_from_text(clean, Some(sport));
        if verified.status == Status::Confirmed
            && verified.sport == Some(sport)
            && verified.confidence >= SPORT_AUTO_CONFIRM_MIN_CONFIDENCE
        {
            let mut evidence = verified.evidence;
            evidence.push(Evidence {
                source: Source::Llm,
                sport,
                confidence: llm_confidence(confidence),
                value: clean.to_owned(),
            });
            return Decision {
                sport: Some(sport),
                status: Status::Confirmed,
                confidence: verified.confidence,
                source: verified.source,
                evidence,
            };
        }
        if verified.status == Status::Confirmed
            && verified.sport.is_some_and(|found| found != sport)
        {
            let mut evidence = verified.evidence;
            evidence.push(Evidence {
                source: Source::Llm,
                sport,
                confidence: 85.0,
                value: clean.to_owned(),
            });
            return unresolved(Status::Conflict, evidence);
        }
    }
    let confidence = llm_confidence(confidence);
    Decision {
        sport: Some(sport),
        status: Status::Pending,
        confidence,
        source: Source::Llm,
        evidence: vec![Evidence {
            source: Source::Llm,
            sport,
            confidence,
            value: clean_evidence
                .unwrap_or("classificação estruturada")
                .to_owned(),
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detecta() {
        let futebol = detect_sport_from_text("⚽ Flamengo x Palmeiras - Brasileirão", None);
        assert_eq!(futebol.sport, Some("Soccer"));
        assert_eq!(futebol.status, Status::Confirmed);
        assert_eq!(futebol.source, Source::Emoji);
        let misto = detect_sport_from_text("🏀 Lakers x Celtics\n⚽ Arsenal x Chelsea", None);
        assert_eq!(misto.status, Status::Conflict);
        assert_eq!(
            detect_sport_from_text("Lega Basket Serie A", None).sport,
            Some("Basketball")
        );
        assert_eq!(
            detect_sport_from_text("nada aqui", None).status,
            Status::Pending
        );
        let ia = llm_sport_decision(Some("futebol"), Some(f64::NAN), None);
        assert!(ia.confidence.is_nan());
        assert_eq!(ia.status, Status::Pending);
    }
}
