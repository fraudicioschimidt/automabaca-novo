//! Registro das modalidades, portado de `src/domain/sports/registry.ts`. Os
//! dados estão em `src/domain/sports/registry-data.json` (o TS tira deles o
//! tipo `CanonicalSport`), que o `build.rs` transforma em `SPORTS_REGISTRY`.

use crate::js;
use crate::text_normalization::normalize_str;
use js_regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

/// A unidade em que o placar de cada modalidade é contado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnidadeDoPlacar {
    Gols,
    Pontos,
    Corridas,
    Sets,
    Games,
    Legs,
    Frames,
    Mapas,
    /// Sem contagem entre dois lados (luta, golfe): placar não liquida.
    Outra,
}

impl UnidadeDoPlacar {
    pub const ALL: [UnidadeDoPlacar; 9] = [
        UnidadeDoPlacar::Gols,
        UnidadeDoPlacar::Pontos,
        UnidadeDoPlacar::Corridas,
        UnidadeDoPlacar::Sets,
        UnidadeDoPlacar::Games,
        UnidadeDoPlacar::Legs,
        UnidadeDoPlacar::Frames,
        UnidadeDoPlacar::Mapas,
        UnidadeDoPlacar::Outra,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            UnidadeDoPlacar::Gols => "gols",
            UnidadeDoPlacar::Pontos => "pontos",
            UnidadeDoPlacar::Corridas => "corridas",
            UnidadeDoPlacar::Sets => "sets",
            UnidadeDoPlacar::Games => "games",
            UnidadeDoPlacar::Legs => "legs",
            UnidadeDoPlacar::Frames => "frames",
            UnidadeDoPlacar::Mapas => "mapas",
            UnidadeDoPlacar::Outra => "outra",
        }
    }

    pub fn parse(text: &str) -> Option<UnidadeDoPlacar> {
        UnidadeDoPlacar::ALL
            .into_iter()
            .find(|unit| unit.as_str() == text)
    }
}

pub struct SportEntry {
    /// Nome persistido em `Bet.esporte`, em inglês, como manda o schema.
    pub canonical: &'static str,
    /// Como o operador chama a modalidade: o rótulo de toda tela.
    pub label_pt: &'static str,
    /// Outras grafias aceitas ao normalizar um esporte já escrito.
    pub aliases: &'static [&'static str],
    /// Emoji que sozinho confirma a modalidade (só os inequívocos).
    pub emojis: &'static [&'static str],
    /// Padrão sobre o texto normalizado do post.
    pub texto: Option<&'static str>,
    /// Ligas e torneios que identificam a modalidade sem ela ser nomeada.
    pub competicoes: Option<&'static str>,
    /// Id do esporte no FlashScore, quando medido.
    pub flashscore_id: Option<u32>,
    pub unidade_do_placar: UnidadeDoPlacar,
}

include!(concat!(env!("OUT_DIR"), "/sports_registry.rs"));

fn compile(source: Option<&str>) -> Option<Regex> {
    source.map(|source| {
        Regex::cataloged(source, "g")
            .unwrap_or_else(|error| panic!("regex inválida no registro /{source}/: {error}"))
    })
}

/// Os padrões de texto e de competição de cada entrada, na ordem do registro.
static PATTERNS: LazyLock<Vec<(Option<Regex>, Option<Regex>)>> = LazyLock::new(|| {
    SPORTS_REGISTRY
        .iter()
        .map(|entry| (compile(entry.texto), compile(entry.competicoes)))
        .collect()
});

pub(crate) fn regexes() -> Vec<&'static Regex> {
    PATTERNS
        .iter()
        .flat_map(|(texto, competicoes)| texto.iter().chain(competicoes))
        .collect()
}

/// Chave de lookup: sem acento, sem caixa, sem espaço.
fn key(name: &str) -> String {
    normalize_str(name)
        .chars()
        .filter(|c| !js::is_whitespace(*c))
        .collect()
}

/// `new Map(pares)`: com chave repetida, vale a última.
static BY_KEY: LazyLock<HashMap<String, &'static str>> = LazyLock::new(|| {
    SPORTS_REGISTRY
        .iter()
        .flat_map(|entry| {
            std::iter::once(entry.canonical)
                .chain(entry.aliases.iter().copied())
                .map(|name| (key(name), entry.canonical))
        })
        .collect()
});

pub fn canonical_sport(value: &str) -> Option<&'static str> {
    let key = key(value);
    if key.is_empty() {
        return None;
    }
    BY_KEY.get(&key).copied()
}

pub fn emoji_signals() -> impl Iterator<Item = (&'static str, &'static str)> {
    SPORTS_REGISTRY
        .iter()
        .flat_map(|entry| entry.emojis.iter().map(|emoji| (*emoji, entry.canonical)))
}

pub fn text_signals() -> impl Iterator<Item = (&'static Regex, &'static str)> {
    SPORTS_REGISTRY
        .iter()
        .zip(PATTERNS.iter())
        .filter_map(|(entry, (texto, _))| texto.as_ref().map(|regex| (regex, entry.canonical)))
}

pub fn competition_signals() -> impl Iterator<Item = (&'static Regex, &'static str)> {
    SPORTS_REGISTRY
        .iter()
        .zip(PATTERNS.iter())
        .filter_map(|(entry, (_, competicoes))| {
            competicoes.as_ref().map(|regex| (regex, entry.canonical))
        })
}

/// Nomes (canônico e aliases, normalizados com espaço) das modalidades em que
/// a unidade dada é o placar. `SCORE_UNIT_RULES` casa esses termos por palavra
/// contra `Bet.esporte`, então o espaço importa: "american football" continua
/// sendo duas palavras.
pub fn esportes_com_unidade(unidade: UnidadeDoPlacar) -> Vec<String> {
    SPORTS_REGISTRY
        .iter()
        .filter(|entry| entry.unidade_do_placar == unidade)
        .flat_map(|entry| std::iter::once(entry.canonical).chain(entry.aliases.iter().copied()))
        .map(normalize_str)
        .collect()
}

/// O que o settlement por placar pode fazer com cada unidade. O `match` é
/// exaustivo de propósito: unidade nova não compila até alguém decidir isto,
/// senão uma unidade que ninguém consome ("Total de Legs") iria direto para o
/// caminho de placar, julgada contra um número cuja unidade nunca foi medida.
///
/// - `None` (por esporte): vale só na lista de esportes daquela unidade, e
///   quem governa é `SCORE_UNIT_RULES` (gols, pontos, corridas).
/// - não medida: o registro diz que o feed entrega a unidade, mas ninguém
///   provou. A linha é recusada até uma sonda medir; a recusa não afirma que
///   o placar não responde, admite que não conferimos.
/// - nunca: não existe contagem entre dois lados (luta, golfe), e nenhuma
///   medição muda isso; não há termo a recusar.
///
/// Os dois últimos recusam igual, mas pelo motivo certo: vôlei declara
/// `sets` e é não medido, não "nunca". Para promover `sets` a por esporte,
/// confira no feed real do FlashScore, num jogo de vôlei, se `scores` vem 3x1
/// (sets) ou 75x68 (pontos).
///
/// Plural nas unidades cujo singular é outra coisa no vocabulário das casas:
/// "Game Handicap" é beisebol, "Leg 1 Winner" é jogo de ida e volta no
/// futebol, "Frame 1 Winner" e "Map 1 Winner" são o vencedor de uma parcial.
/// Todos já são recusados por outra regra; o plural evita recusá-los pelo
/// motivo errado. `sets` mantém o singular opcional, o comportamento que já
/// existia.
fn termos_recusados(unidade: UnidadeDoPlacar) -> Option<&'static [&'static str]> {
    match unidade {
        UnidadeDoPlacar::Gols | UnidadeDoPlacar::Pontos | UnidadeDoPlacar::Corridas => None,
        UnidadeDoPlacar::Games => Some(&["games"]),
        UnidadeDoPlacar::Sets => Some(&["sets?"]),
        UnidadeDoPlacar::Legs => Some(&["legs"]),
        UnidadeDoPlacar::Frames => Some(&["frames"]),
        UnidadeDoPlacar::Mapas => Some(&["mapas", "maps"]),
        UnidadeDoPlacar::Outra => Some(&[]),
    }
}

/// Termos de unidade que nunca liquidam por placar, derivados das modalidades
/// que o sistema modela: esporte novo com unidade nova entra aqui sozinho, sem
/// o que dardos e snooker liquidariam por um placar de unidade desconhecida.
pub fn termos_de_unidade_sem_placar() -> Vec<&'static str> {
    let mut unidades: Vec<UnidadeDoPlacar> = Vec::new();
    for entry in SPORTS_REGISTRY {
        if !unidades.contains(&entry.unidade_do_placar) {
            unidades.push(entry.unidade_do_placar);
        }
    }
    unidades
        .into_iter()
        .filter_map(termos_recusados)
        .flatten()
        .copied()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registro() {
        assert_eq!(canonical_sport("Futebol"), Some("Soccer"));
        assert_eq!(canonical_sport("  hóquei no gelo "), Some("Hockey"));
        assert_eq!(canonical_sport(""), None);
        assert_eq!(canonical_sport("curling"), None);
        assert!(
            esportes_com_unidade(UnidadeDoPlacar::Pontos).contains(&"american football".to_owned())
        );
        assert!(termos_de_unidade_sem_placar().contains(&"legs"));
        assert_eq!(
            regexes().len(),
            text_signals().count() + competition_signals().count()
        );
    }
}
