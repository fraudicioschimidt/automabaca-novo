import { availableParallelism } from "node:os";

/**
 * Quantos workers o projeto `db` usa. Cada um recebe um Postgres isolado
 * (`<base>_1` … `_N`), então o teto também é o número de bancos que o
 * global-setup cria. Boa parte do tempo da suíte db é espera (polling do
 * pg-boss, backoff), por isso 6 workers rendem mesmo em máquina de 6 núcleos.
 */
export const DB_TEST_MAX_WORKERS = Math.max(1, Math.min(6, availableParallelism()));
