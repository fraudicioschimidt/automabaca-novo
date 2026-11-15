import { z } from "zod";
import {
  KICKOFF_WINDOW_DAYS,
  MAX_ODDS,
  MAX_STAKE_UNIDADES,
} from "@/src/domain/bet-capture";
import { roundMoney } from "@/src/domain/money";
import { MAX_LIVE_SCORE_AT_TIP } from "@/src/domain/live-score-at-tip";

/**
 * Tetos de sanidade de aposta: saída de LLM/tipster é input hostil. O registro
 * e a edição in-place passam pelos mesmos tetos, para que nenhuma porta de
 * escrita grave odds/stake/data fora do plausível.
 */

export const oddsSanity = z
  .number()
  .gt(1, "Odd precisa ser maior que 1.")
  .lte(MAX_ODDS, `Odd acima do teto de sanidade (${MAX_ODDS}).`)
  .transform((value) => roundMoney(value, 4))
  .refine((value) => value > 1, "Odd precisa permanecer maior que 1 após normalização.");

export const stakeSanity = z
  .number()
  .positive("Stake precisa ser positiva.")
  .lte(MAX_STAKE_UNIDADES, `Stake acima do teto de sanidade (${MAX_STAKE_UNIDADES}u).`)
  .transform((value) => roundMoney(value, 6))
  .refine((value) => value > 0, "Stake precisa permanecer positiva após normalização.");

export const kickoffSanity = z.date().refine(
  (d) => Math.abs(d.getTime() - Date.now()) / 86_400_000 <= KICKOFF_WINDOW_DAYS,
  { message: `Data do evento fora da janela de ±${KICKOFF_WINDOW_DAYS} dias.` },
);

export const eventoSanity = z.string().trim().min(1, "Evento é obrigatório.").max(300);
export const esporteSanity = z.string().trim().min(1, "Esporte é obrigatório.").max(80);
export const mercadoSanity = z.string().trim().min(1, "Mercado é obrigatório.").max(150);
export const selecaoSanity = z.string().trim().min(1, "Seleção é obrigatória.").max(200);

/** Campos de uma edição in-place de aposta, com os mesmos tetos do registro. */
export const betEditSanitySchema = z.object({
  data: kickoffSanity,
  evento: eventoSanity,
  esporte: esporteSanity,
  competicao: z.string().trim().max(200),
  pais: z.string().trim().max(100),
  mercado: mercadoSanity,
  selecao: selecaoSanity,
  liveScoreHome: z.number().int().min(0).max(MAX_LIVE_SCORE_AT_TIP).optional(),
  liveScoreAway: z.number().int().min(0).max(MAX_LIVE_SCORE_AT_TIP).optional(),
  odds: oddsSanity,
  stake: stakeSanity,
  casaDeAposta: z.string().trim().max(100).optional(),
});
