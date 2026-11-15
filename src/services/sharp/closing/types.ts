import type { EligibleBet } from "@/src/domain/settlement/ticket-resolution";
import type { BridgeQueryFn } from "@/src/providers/bridgeodds/scoring";

/** A aposta como o `closing.sync` a lê: os termos e o preço, sem o resultado, que é da liquidação. */
export type ClosingSyncBet = Omit<EligibleBet, "result">;

/**
 * Quanto o disparo MANUAL de closing pode gastar esperando o provedor.
 *
 * O clique do operador roda o pipeline inteiro dentro da requisição HTTP. Sem
 * teto, um lote grande com cadência de 40s por chamada seguraria uma conexão
 * do pool por minutos — e cada nova tentativa empurraria a fila do cron.
 * 25s é o que um clique tolera sem parecer travado; o que não couber volta
 * como `adiadas` e o ciclo automático pega depois.
 */
export const CLOSING_MANUAL_BUDGET_MS = 25_000;


export type ClosingSyncResult = {
  processed: number;
  closed: number;
  failures: number;
  /** Apostas que ficaram para a próxima volta por falta de tempo (orçamento do
   *  provedor ou prazo da rodada): não são falha, e o ciclo seguinte as pega. */
  adiadas: number;
};

export type ClosingDeps = {
  query?: BridgeQueryFn;
  now?: Date;
  batchSize?: number;
  /** Escopa o ciclo a UMA banca — botão "Odds fechamento" manual da ficha. O
   *  cron roda sem isto (todas as bancas); o race-guard cuida da concorrência. */
  bankrollId?: string;
  /** Do job: abortado no prazo da rodada, quando o job expira ou o worker encerra. Aposta ainda não começada fica adiada. */
  signal?: AbortSignal;
};

