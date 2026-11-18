//! Regras puras do AutomaBACA, portadas de `src/domain/` (fase 1 de
//! `docs/MIGRACAO-RUST.md`). Nada aqui lê banco, rede, disco ou relógio: quem
//! chama passa o instante e os dados, como no TypeScript.
#![forbid(unsafe_code)]

pub mod cron;
pub mod dates;
pub mod decimal_input;
pub mod js;
pub mod kelly;
pub mod kickoff;
pub mod money;
pub mod odds;
pub mod team_category;
pub mod text;
pub mod text_normalization;

/// Todo regex do domínio, com as flags, para o teste que compara os dois
/// lados da ponte com o V8. Cada módulo com regex compila as suas aqui.
pub fn regex_catalog() -> Vec<(String, String)> {
    kickoff::regexes();
    team_category::regexes();
    text::regexes();
    js_regex::catalog()
}
