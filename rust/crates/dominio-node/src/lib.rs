//! Ponte N-API do crate `dominio`. Cada função aqui só converte os tipos do
//! JavaScript e delega; a regra mora no `dominio`.

use napi_derive::napi;

/// Versão do binário, para o empacotamento conferir que ele carrega.
#[napi]
pub fn versao() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}
