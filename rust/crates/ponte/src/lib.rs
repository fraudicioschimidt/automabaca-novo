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
