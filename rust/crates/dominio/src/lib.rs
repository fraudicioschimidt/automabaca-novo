//! Regras puras do AutomaBACA, portadas de `src/domain/` (fase 1 de
//! `docs/MIGRACAO-RUST.md`). Nada aqui lê banco, rede, disco ou relógio: quem
//! chama passa o instante e os dados, como no TypeScript.
#![forbid(unsafe_code)]

pub mod cron;
pub mod kelly;
