//! Ponte do crate `dominio` para o JavaScript. O mesmo código chega aos dois
//! lados: N-API nos processos Node (web e worker) e WebAssembly no navegador.
//! Cada função só converte os tipos do JavaScript e delega; a regra mora no
//! `dominio`. Os dois módulos exportam os mesmos nomes, com os mesmos valores
//! (`null` para ausência, `Array` para listas, `Error` com a mensagem do
//! domínio): `tests/plataforma/ponte.test.ts` confere.

#[cfg(not(target_arch = "wasm32"))]
pub mod node;
mod regex_probe;
#[cfg(target_arch = "wasm32")]
pub mod wasm;

/// Os candidatos em colunas (o que a casca extraiu de cada um) → os índices
/// que o refinamento por categoria deixa. Liga e país vazios valem como
/// ausentes, como o `?? ""` do TypeScript.
pub(crate) fn refine_candidates(
    bet: &dominio::text::CategoryRefinement<'_>,
    [homes, aways, leagues, countries]: [Vec<String>; 4],
    kickoffs: &[f64],
    swapped: &[u32],
) -> Vec<u32> {
    let present = |text: String| (!text.is_empty()).then_some(text);
    let candidates: Vec<dominio::text::CategoryCandidateFixture> = homes
        .into_iter()
        .zip(aways)
        .zip(leagues)
        .zip(countries)
        .enumerate()
        .map(
            |(index, (((home, away), league), country))| dominio::text::CategoryCandidateFixture {
                home,
                away,
                league: present(league),
                country: present(country),
                kickoff_ms: kickoffs.get(index).copied().unwrap_or(f64::NAN),
                swapped: swapped.get(index).is_some_and(|flag| *flag != 0),
            },
        )
        .collect();
    dominio::text::refine_category_candidates(bet, &candidates)
        .into_iter()
        .map(|index| index as u32)
        .collect()
}
