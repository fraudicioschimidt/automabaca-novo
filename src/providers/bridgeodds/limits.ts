/**
 * Teto efetivo medido no endpoint `opening-closing`. A documentação não
 * declara quota e a informação verbal de 1.000/h não se confirmou: em várias
 * horas independentes, exatamente 100 chamadas passaram e as seguintes
 * receberam HTTP 429. Até o fornecedor esclarecer, vale a medição.
 */
export const BRIDGEODDS_CONTRACTED_REQUESTS_PER_HOUR = 100;

/** Reserva 10% para uso manual/externo e diferenças na janela do fornecedor. */
export const BRIDGEODDS_OPERATIONAL_REQUESTS_PER_HOUR = 90;

/**
 * Distribui o soft-cap ao longo da hora em vez de consumir as 90 chamadas nos
 * primeiros minutos. Como não há limite por minuto nem headers publicados,
 * 40 segundos é a cadência sustentável mais rápida compatível com 90/h.
 */
export const BRIDGEODDS_REQUEST_COOLDOWN_MS = Math.ceil(
  60 * 60_000 / BRIDGEODDS_OPERATIONAL_REQUESTS_PER_HOUR,
);

/**
 * Idade máxima de um preço "atual" BridgeOdds, igual à da Pinnacle17 (15min).
 * O frescor operacional continua sendo 60s; este é o teto externo que impede
 * um snapshot reaproveitado (reprocess, cache persistente) de virar CLV velho.
 */
export const BRIDGEODDS_CURRENT_PRICE_MAX_AGE_MS = 15 * 60_000;
