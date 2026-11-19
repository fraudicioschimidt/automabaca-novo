import { z } from "zod";
import type { JogadorDaPartida } from "@/src/domain/settlement/goalscorer-matching";
import {
  PLAYER_PROP_KEYS,
  type PlayerPropKey,
} from "@/src/domain/settlement/player-prop-classify";

/**
 * `/matches/match/player-stats` — ~100 chaves por jogador, cada uma em
 * `{ value, raw_value, rank }`. O schema é DELIBERADAMENTE tolerante no miolo
 * (`stats` é um mapa livre) e estrito na borda que decide dinheiro (`GOALS`,
 * `GOALS_OWN` e as chaves da Fase 1): provider é input hostil, mas recusar a
 * resposta inteira porque uma chave irrelevante mudou de forma transformaria
 * detalhe em falha de settlement.
 */

const valorSchema = z
  .object({
    value: z.unknown().optional(),
    raw_value: z.unknown().optional(),
  })
  .passthrough();

const playerSchema = z
  .object({
    player_id: z.string().min(1),
    name: z.string().optional().nullable(),
    short_name: z.string().optional().nullable(),
    team_id: z.string().optional().nullable(),
    in_base_lineup: z.boolean().optional().nullable(),
    stats: z.record(z.string(), valorSchema).optional().nullable(),
  })
  .passthrough()
  .superRefine((player, ctx) => {
    // Chave ausente é o zero do feed completo; chave publicada inválida não
    // prova zero gols. Recusar o payload também preserva os homônimos na decisão.
    for (const key of ["GOALS", "GOALS_OWN"]) {
      if (player.stats && Object.hasOwn(player.stats, key) && playerStatCount(player.stats[key]?.raw_value) === undefined) {
        ctx.addIssue({ code: "custom", path: ["stats", key, "raw_value"], message: "Contagem de gols inválida." });
      }
    }
  });

const nonemptyResponseSchema = z
  .object({ players: z.array(playerSchema).optional().nullable() })
  .passthrough();

// Measured on EZQZW8kC: lack of coverage is HTTP 200 + [], not a provider outage.
export const flashscorePlayerStatsResponseSchema = z.union([
  nonemptyResponseSchema, z.array(z.never()).transform(() => ({ players: [] })),
]);

export type FlashscorePlayerStatsResponse = z.infer<
  typeof flashscorePlayerStatsResponseSchema
>;

export function playerStatCount(bruto: unknown): number | undefined {
  if (typeof bruto === "string" && !/^\d+(?:\.0+)?$/.test(bruto.trim())) return undefined;
  if (typeof bruto !== "number" && typeof bruto !== "string") return undefined;
  const value = Number(bruto);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * `raw_value` é o número limpo (`"0.666667"`), `value` é o formatado (`"66.67%"`).
 * Só o cru serve para contar. Gol ausente vira 0 porque a lista encerrada é
 * completa — "não está com gol" significa "não marcou". As demais chaves NÃO
 * herdam esse default: omitir `FOULS_SUFFERED` não é zero faltas sofridas.
 */
function contagemDeGol(bruto: unknown): number {
  return playerStatCount(bruto) ?? 0;
}

/**
 * Jogadores da partida. `GOALS` exclui gol contra e inclui pênalti — conferido
 * no payload real. Props da Fase 1 entram em `stats` só quando o feed
 * publicou a chave.
 */
export function normalizeFlashscorePlayers(
  payload: FlashscorePlayerStatsResponse,
): JogadorDaPartida[] {
  return (payload.players ?? []).flatMap((player) => {
    const nome = player.name?.trim();
    if (!nome) return [];
    const bruto = player.stats ?? {};
    const minutosJogados = playerStatCount(bruto["MATCH_MINUTES_PLAYED"]?.raw_value);
    const stats: Partial<Record<PlayerPropKey, number>> = {};
    for (const key of PLAYER_PROP_KEYS) {
      const n = playerStatCount(bruto[key]?.raw_value);
      if (n !== undefined) stats[key] = n;
    }
    return [
      {
        playerId: player.player_id,
        teamId: player.team_id ?? null,
        nome,
        nomeCurto: player.short_name?.trim() || null,
        gols: contagemDeGol(bruto["GOALS"]?.raw_value),
        golsContra: contagemDeGol(bruto["GOALS_OWN"]?.raw_value),
        ...(minutosJogados === undefined ? {} : { minutosJogados }),
        ...(player.in_base_lineup === undefined
          ? {}
          : { titular: player.in_base_lineup }),
        stats,
      },
    ];
  });
}
/** Validated count keys: four fixtures / four competitions. See measured test fixture. */
export const VERIFIED_PLAYER_STAT_KEYS: readonly string[] = ["FOULS_SUFFERED", "FOULS_COMMITTED", "SHOTS_TOTAL", "SHOTS_ON_TARGET", "TACKLES_TOTAL", "TACKLES_WON", "CARDS_YELLOW", "CARDS_RED", "CARDS_YELLOW_SECOND", "ASSISTS_GOAL", "INTERCEPTIONS", "KEY_PASSES", "OFFSIDES", "SAVES_TOTAL", "PASSES_TOTAL", "PASSES_ACCURATE"];
