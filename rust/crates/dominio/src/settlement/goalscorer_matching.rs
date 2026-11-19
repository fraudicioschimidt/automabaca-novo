//! O nome do jogador na seleção contra a lista da partida, portado de
//! `src/domain/settlement/goalscorer-matching.ts`. Mesmo limiar e unicidade
//! para o artilheiro e as props de jogador: nenhum dos dois pode ter um
//! casamento mais frouxo.

use crate::js;
use crate::text_normalization::normalize_str;

const PARTICULAS: &[&str] = &[
    "de", "da", "do", "das", "dos", "del", "della", "di", "du", "van", "von", "der", "den", "ter",
    "el", "al", "bin", "ibn", "la", "le", "jr", "junior", "filho", "neto", "sr", "senior",
];

/// Similaridade mínima para liquidar sozinho.
pub const GOALSCORER_MIN_SIMILARIDADE: f64 = 0.82;
/// Distância mínima até o segundo colocado. Dois "Silva" na mesma partida
/// têm que virar caso de treino, não um chute com cara de decisão.
pub const GOALSCORER_MIN_VANTAGEM: f64 = 0.15;

/// Palavras do MERCADO que a casa cola no nome do jogador ("Haaland -
/// Marcar a qualquer momento", "Vinicius Jr Sim"). Removidas por TOKEN,
/// nunca por regex sobre o texto cru: ver `tokens_da_selecao`.
const PALAVRAS_DE_MERCADO: &[&str] = &[
    "marcar",
    "para",
    "anytime",
    "goalscorer",
    "scorer",
    "qualquer",
    "momento",
    "sim",
    "nao",
    "yes",
    "no",
    "gol",
    "gols",
    "goal",
    "goals",
    // Props de jogador: a seleção cola over/under e a estatística no nome
    // ("willian jose over 0,5 sofre falta"). Sem isto o casamento tenta
    // "sofre"/"falta" contra o feed e falha fechado à toa.
    "over",
    "under",
    "mais",
    "menos",
    "acima",
    "abaixo",
    "falta",
    "faltas",
    "foul",
    "fouls",
    "sofre",
    "sofrida",
    "sofridas",
    "suffered",
    "comete",
    "cometida",
    "cometidas",
    "committed",
    "remate",
    "remates",
    "baliza",
    "porta",
    "completed",
    "accurate",
    "completos",
    "completo",
    "chute",
    "chutes",
    "shot",
    "shots",
    "finalizacao",
    "finalizacoes",
    "alvo",
    "target",
    "desarme",
    "desarmes",
    "tackle",
    "tackles",
    "ganho",
    "ganhos",
    "certo",
    "certos",
    "won",
    "cartao",
    "cartoes",
    "card",
    "cards",
    "amarelo",
    "amarelos",
    "vermelho",
    "vermelhos",
    "yellow",
    "red",
    "booking",
    "bookings",
    "assistencia",
    "assistencias",
    "assist",
    "assists",
    "interceptacao",
    "interceptacoes",
    "interception",
    "interceptions",
    "key",
    "passe",
    "passes",
    "chave",
    "decisivo",
    "decisivos",
    "impedimento",
    "impedimentos",
    "offside",
    "offsides",
    "defesa",
    "defesas",
    "save",
    "saves",
    "jogador",
    "jogadora",
    "player",
    "atleta",
    "total",
    "totais",
    "on",
    // Quantidade de gols ("Haaland 3+", "Haaland hat-trick", "2 ou mais"):
    // quem lê a quantidade é `requiredPlayerGoals`; aqui só não vira nome.
    "hat",
    "trick",
    "tricks",
    "hattrick",
    "brace",
    "bis",
    "ou",
    "or",
    "more",
    "least",
    "minimo",
];

/// Tokens que NEGAM o gol. `PALAVRAS_DE_MERCADO` os apaga junto com
/// "marcar" e "anytime", só que "marcar" é ruído e "não" é o LADO DA APOSTA:
/// apagados, "Haaland - Não" viraria "Haaland" e o veredito sairia WON com o
/// jogador tendo marcado.
const NEGACOES: &[&str] = &["nao", "not", "sem", "never", "nunca"];

/// "no" é AMBÍGUO: negação em inglês ("Haaland - No", "No Goalscorer") e
/// PREPOSIÇÃO em português ("marcar no 1º tempo"). Conta como negação onde a
/// casa põe o rótulo: no FIM do texto, ou logo antes do substantivo negado.
const NEGADOS_APOS_NO: &[&str] = &[
    "goal",
    "goals",
    "gol",
    "gols",
    "score",
    "scorer",
    "goalscorer",
    "anytime",
];

/// Palavras do texto sem acento e sem pontuação; hífen separa como espaço.
fn palavras_normalizadas(texto: &str) -> Vec<String> {
    let cleaned: String = normalize_str(texto)
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || js::is_whitespace(c) {
                c
            } else {
                ' '
            }
        })
        .collect();
    cleaned
        .split(|c| c == '-' || js::is_whitespace(c))
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Tokens comparáveis: sem acento, sem pontuação, sem partícula.
pub fn tokens_do_nome(nome: &str) -> Vec<String> {
    palavras_normalizadas(nome)
        .into_iter()
        .filter(|token| !PARTICULAS.contains(&token.as_str()))
        .collect()
}

/// `curto` é abreviação plausível de `longo` ("f" para "franco"). O
/// tamanho é o do JS, em unidades UTF-16.
fn eh_inicial_de(curto: &str, longo: &str) -> bool {
    curto.encode_utf16().count() == 1 && longo.starts_with(curto)
}

/// Similaridade 0..1 entre o nome da seleção e o nome do feed, **sem ordem**.
///
/// Cada token do lado MENOR busca par no lado maior: igual vale 1, inicial
/// vale 0.5 (evidência fraca: "F." casa com Franco, Fernando e Felipe). A
/// nota é a soma dos pares sobre o tamanho do lado menor, com teto pela
/// fração do lado maior que ficou coberta: assim "Silva" sozinho não vira 1.0
/// contra "Silva Rodrigo".
pub fn similaridade_de_tokens<A: AsRef<str>, B: AsRef<str>>(ta: &[A], tb: &[B]) -> f64 {
    if ta.is_empty() || tb.is_empty() {
        return 0.0;
    }
    let ta: Vec<&str> = ta.iter().map(AsRef::as_ref).collect();
    let tb: Vec<&str> = tb.iter().map(AsRef::as_ref).collect();
    let (menor, maior) = if ta.len() <= tb.len() {
        (ta, tb)
    } else {
        (tb, ta)
    };
    let mut disponiveis = maior.clone();
    let mut pontos = 0.0;
    let mut pareados = 0.0;
    for token in &menor {
        if let Some(exato) = disponiveis.iter().position(|outro| outro == token) {
            disponiveis.remove(exato);
            pontos += 1.0;
            pareados += 1.0;
            continue;
        }
        if let Some(inicial) = disponiveis
            .iter()
            .position(|outro| eh_inicial_de(token, outro) || eh_inicial_de(outro, token))
        {
            disponiveis.remove(inicial);
            pontos += 0.5;
            pareados += 1.0;
        }
    }
    if pontos == 0.0 {
        return 0.0;
    }
    let nota_menor = pontos / menor.len() as f64;
    // Cobertura do lado maior: um sobrenome isolado casando com o nome
    // completo cai para ~0.5 e não passa no limiar sozinho.
    let cobertura = pareados / maior.len() as f64;
    nota_menor * (0.5 + 0.5 * cobertura)
}

/// O texto antes do primeiro `/\s+[-–—]\s+/` (o sufixo de mercado que a casa
/// cola: "Haaland - Marcar a qualquer momento").
fn sem_sufixo_de_mercado(selecao: &str) -> &str {
    let chars: Vec<(usize, char)> = selecao.char_indices().collect();
    let mut i = 0;
    while i < chars.len() {
        if !js::is_whitespace(chars[i].1) {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && js::is_whitespace(chars[i].1) {
            i += 1;
        }
        let dash = chars
            .get(i)
            .is_some_and(|(_, c)| matches!(c, '-' | '–' | '—'));
        let space_after = chars.get(i + 1).is_some_and(|(_, c)| js::is_whitespace(*c));
        if dash && space_after {
            return &selecao[..chars[start].0];
        }
    }
    selecao
}

/// Tokens do nome do jogador na seleção, já sem o vocabulário do mercado.
///
/// Filtra por TOKEN, depois de normalizar. Regex sobre o texto CRU não
/// serve: em JS `\b` trata letra acentuada como não-palavra, então `\bsim\b`
/// casaria dentro de "Simão" e `\bno\b` dentro de "Noé".
pub fn tokens_da_selecao(selecao: &str) -> Vec<String> {
    tokens_do_nome(sem_sufixo_de_mercado(selecao))
        .into_iter()
        .filter(|token| !PALAVRAS_DE_MERCADO.contains(&token.as_str()) && !js::all_digits(token))
        .collect()
}

/// Algum dos textos nega o gol. Olha o texto INTEIRO, sem cortar no sufixo
/// de mercado: é no sufixo (" - Não") que a casa costuma pôr a polaridade.
pub fn tem_polaridade_negativa<S: AsRef<str>>(textos: &[S]) -> bool {
    textos.iter().any(|texto| {
        let tokens = palavras_normalizadas(texto.as_ref());
        tokens.iter().enumerate().any(|(indice, token)| {
            if NEGACOES.contains(&token.as_str()) {
                return true;
            }
            if token != "no" {
                return false;
            }
            tokens
                .get(indice + 1)
                .is_none_or(|proximo| NEGADOS_APOS_NO.contains(&proximo.as_str()))
        })
    })
}

/// Recusa do casamento, com os nomes da lista que empataram.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchRefusal {
    SelecaoSemJogador,
    SemJogadores,
    JogadorNaoEncontrado,
    JogadorAmbiguo,
}

impl MatchRefusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SelecaoSemJogador => "selecao_sem_jogador",
            Self::SemJogadores => "sem_jogadores",
            Self::JogadorNaoEncontrado => "jogador_nao_encontrado",
            Self::JogadorAmbiguo => "jogador_ambiguo",
        }
    }
}

/// O jogador casado (índice na lista recebida) ou a recusa, com os índices
/// dos candidatos quando a recusa é ambiguidade.
#[derive(Debug, Clone, PartialEq)]
pub enum PlayerNameMatch {
    Found {
        indice: usize,
        similaridade: f64,
        vantagem: f64,
    },
    Refused {
        reason: MatchRefusal,
        candidatos: Vec<usize>,
    },
}

pub const PLAYER_MATCH_REFUSALS: [MatchRefusal; 4] = [
    MatchRefusal::SelecaoSemJogador,
    MatchRefusal::SemJogadores,
    MatchRefusal::JogadorNaoEncontrado,
    MatchRefusal::JogadorAmbiguo,
];

impl PlayerNameMatch {
    /// Números para a ponte: `[-1, indice, similaridade, vantagem]` quando
    /// casou; `[recusa, ...candidatos]` quando não, com a recusa como posição
    /// em `PLAYER_MATCH_REFUSALS`.
    pub fn encoded(&self) -> Vec<f64> {
        match self {
            Self::Found {
                indice,
                similaridade,
                vantagem,
            } => {
                vec![-1.0, *indice as f64, *similaridade, *vantagem]
            }
            Self::Refused { reason, candidatos } => {
                let code = PLAYER_MATCH_REFUSALS
                    .iter()
                    .position(|item| item == reason)
                    .unwrap_or(0);
                std::iter::once(code as f64)
                    .chain(candidatos.iter().map(|&i| i as f64))
                    .collect()
            }
        }
    }
}

/// Um jogador da partida: o nome como o feed escreve e o abreviado, quando
/// publicado (`None` ou vazio, sem abreviado).
pub struct NamedPlayer<'a> {
    pub nome: &'a str,
    pub nome_curto: Option<&'a str>,
}

/// Casa o nome da seleção com a lista da partida.
pub fn encontrar_jogador_na_partida(selecao: &str, jogadores: &[NamedPlayer]) -> PlayerNameMatch {
    let refused = |reason, candidatos| PlayerNameMatch::Refused { reason, candidatos };
    let alvo = tokens_da_selecao(selecao);
    if alvo.is_empty() {
        return refused(MatchRefusal::SelecaoSemJogador, Vec::new());
    }
    if jogadores.is_empty() {
        return refused(MatchRefusal::SemJogadores, Vec::new());
    }
    struct Nota {
        indice: usize,
        tokens: Vec<String>,
        nota: f64,
    }
    let mut notas: Vec<Nota> = jogadores
        .iter()
        .enumerate()
        .map(|(indice, jogador)| {
            let nome = tokens_do_nome(jogador.nome);
            let curto = jogador.nome_curto.map(tokens_do_nome).unwrap_or_default();
            let nota = js::max(
                similaridade_de_tokens(&alvo, &nome),
                if curto.is_empty() {
                    0.0
                } else {
                    similaridade_de_tokens(&alvo, &curto)
                },
            );
            let mut tokens = nome;
            tokens.extend(curto);
            Nota {
                indice,
                tokens,
                nota,
            }
        })
        .collect();
    // O `sort` do JS é estável: empate mantém a ordem da lista.
    notas.sort_by(|x, y| {
        y.nota
            .partial_cmp(&x.nota)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    if let [unico] = alvo.as_slice()
        && unico.len() >= 3
    {
        let exatos: Vec<usize> = (0..notas.len())
            .filter(|&posicao| notas[posicao].tokens.contains(unico))
            .collect();
        if let [so] = exatos.as_slice() {
            let so = &notas[*so];
            let outro = notas
                .iter()
                .find(|item| item.indice != so.indice)
                .map_or(0.0, |item| item.nota);
            return PlayerNameMatch::Found {
                indice: so.indice,
                similaridade: so.nota,
                vantagem: so.nota - outro,
            };
        }
        if exatos.len() > 1 {
            let candidatos = exatos
                .iter()
                .map(|&posicao| notas[posicao].indice)
                .collect();
            return refused(MatchRefusal::JogadorAmbiguo, candidatos);
        }
    }

    let melhor = &notas[0];
    if melhor.nota < GOALSCORER_MIN_SIMILARIDADE {
        return refused(MatchRefusal::JogadorNaoEncontrado, Vec::new());
    }
    let segundo = notas.get(1);
    let vantagem = melhor.nota - segundo.map_or(0.0, |item| item.nota);
    if segundo.is_some() && vantagem < GOALSCORER_MIN_VANTAGEM {
        let candidatos = notas
            .iter()
            .filter(|item| melhor.nota - item.nota < GOALSCORER_MIN_VANTAGEM)
            .map(|item| item.indice)
            .collect();
        return refused(MatchRefusal::JogadorAmbiguo, candidatos);
    }
    PlayerNameMatch::Found {
        indice: melhor.indice,
        similaridade: melhor.nota,
        vantagem,
    }
}

/// "Não marcou" só vale LOST para quem entrou em campo. Minutos publicados,
/// a escalação ou um gol na partida provam a entrada; sem nenhum dos três, a
/// ausência de gol não prova nada, o mesmo critério das props de jogador.
pub fn participation_unproven(minutos_publicados: bool, participou: bool, sem_gols: bool) -> bool {
    !minutos_publicados && !participou && sem_gols
}

/// O feed mostra o jogador no elenco com zero minuto e sem gol: não entrou.
/// As casas anulam a aposta de gol de quem não entrou, então ela sai VOID.
pub fn listed_but_did_not_play(minutos: Option<f64>, participou: bool, sem_gols: bool) -> bool {
    minutos.is_some_and(|minutos| minutos <= 0.0) && !participou && sem_gols
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jogador<'a>(nome: &'a str, nome_curto: Option<&'a str>) -> NamedPlayer<'a> {
        NamedPlayer { nome, nome_curto }
    }

    #[test]
    fn tokens_e_polaridade() {
        assert_eq!(tokens_do_nome("Vinícius Júnior"), ["vinicius"]);
        assert_eq!(
            tokens_da_selecao("Haaland - Marcar a qualquer momento"),
            ["haaland"]
        );
        assert_eq!(tokens_da_selecao("Simão Sim"), ["simao"]);
        assert!(tem_polaridade_negativa(&["Haaland - Não"]));
        assert!(tem_polaridade_negativa(&["", "No Goalscorer"]));
        assert!(!tem_polaridade_negativa(&["marcar no 1º tempo"]));
    }

    #[test]
    fn casa_o_jogador() {
        let lista = [
            jogador("Haaland Erling", Some("Haaland E.")),
            jogador("Silva Rodrigo", None),
        ];
        let PlayerNameMatch::Found { indice, .. } =
            encontrar_jogador_na_partida("Erling Haaland", &lista)
        else {
            panic!("devia casar");
        };
        assert_eq!(indice, 0);
        let dois = [jogador("Silva Rodrigo", None), jogador("Silva Bruno", None)];
        assert_eq!(
            encontrar_jogador_na_partida("Silva", &dois),
            PlayerNameMatch::Refused {
                reason: MatchRefusal::JogadorAmbiguo,
                candidatos: vec![0, 1]
            }
        );
        assert_eq!(
            encontrar_jogador_na_partida("over 0.5", &dois),
            PlayerNameMatch::Refused {
                reason: MatchRefusal::SelecaoSemJogador,
                candidatos: vec![]
            }
        );
        assert!(listed_but_did_not_play(Some(0.0), false, true));
        assert!(participation_unproven(false, false, true));
        assert!((similaridade_de_tokens(&["silva"], &["silva", "rodrigo"]) - 0.75).abs() < 1e-12);
    }
}
